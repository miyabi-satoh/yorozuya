#!/usr/bin/env node
// 各 claude ペインのステータスラインからコンテキストの使用率を読み、閾値以上になったら1行出す。
// Claude Code の更新の知らせ（再起動で反映される）と、放置のヒントが出ているペインも1行ずつ出す。
// usage: watch-context.mjs [--pattern <正規表現>] [--threshold <使用率>] [--interval 120] [--update-pattern <正規表現>] [--idle-pattern <正規表現>] [--goal-pattern <正規表現>] [--no-update] [--no-idle] [--no-goal] [--start] [--once]
// --pattern 以外の引数は省ける。優先順は 引数 → config.local.json の watch → DEFAULTS。
// --pattern はステータスラインの表示しだいで、誰にでも合う既定値が無いので、引数か config.local.json で必ず渡す。
//
// 出すのは「聞きに行くきっかけ」だけ。区切りかどうか、再起動するかは読んだ側と対象が決める。
// 画面からの読み取りで後戻りできない操作まで進めない。読み違えても、依頼が早いか遅いかで済むようにする。
//
// stdout の1行が1件の知らせ（Monitor で受ける前提）。列と扱いは SKILL.md の「コンテキストを見張る」にある。
// START は --start を付けたときだけ、Herdr の一覧が最初に取れた回に、その回の知らせより先に出す。
// 既定で出さないのは、Monitor で張り直すたびに START で起こされないため。`| grep -v '^START'` で落とす手は使わない。
// Claude Code のシェルでは grep が別物（組み込みの ugrep のシェル関数）に差し替わっていて、走りっぱなしの入力では行が流れず、OVER も UPDATE も届かなくなる（notes/watch-context.md 2026-09-20）。
// OVER・UPDATE・IDLE と WARN（ペインごと）はセッションごとに1回だけ出す。覚えているのはこのプロセスの中だけ。
//
// --pattern は使用率の数字を1つ目のキャプチャで取る。入力欄の下枠より下（ステータスライン）だけに当てる。
// 照合の前にノーブレークスペースを普通の空白に揃える。
// --update-pattern は、入力欄の上枠のすぐ上の1行だけに当てる。--no-update を付ければ更新は見ない。
// --idle-pattern も同じ1行に当てる。Claude Code の「放置から戻ったときのヒント」（`new task? /clear to save …`。
// コンテキスト 10万トークン以上で、最後の応答から 75 分たつと出る。2.1.278 のコードで確認）を拾う。--no-idle を付ければ見ない。
// --goal-pattern も同じ1行に当てる。`/goal`（自律的な目標追従モード）が動いている間は
// OVER・UPDATE・IDLE をどれも出さない（区切りの確認で割り込むと、目標追従を途中で止めることになるため）。
// 表示の `(Nm)` は経過時間で、上限の長さは分からない（2026-09-23 実測で 5m→7m と増え続けた）。
// 長く動き続けるなら、その間は見張りが黙り続ける。通知先の集合には加えない（何回でも継続を判定できるようにする）ので、
// `/goal` が外れれば次の tick で改めて出る。--no-goal を付ければ見ない。

import { parseArgs } from 'node:util';
import { CONFIG, loadConfig } from './lib/config.mjs';
import { AGENT_LIST_LINE, bottomBorder, herdr, herdrError, herdrJson, readScreen } from './lib/herdr.mjs';

const usage = 'usage: watch-context.mjs [--pattern <正規表現>] [--threshold <使用率>] [--interval 120] [--update-pattern <正規表現>] [--idle-pattern <正規表現>] [--goal-pattern <正規表現>] [--no-update] [--no-idle] [--no-goal] [--start] [--once]\n--pattern は引数か config.local.json の watch.pattern で必ず渡す';

// --pattern の既定は持たない（上の usage の説明）。
const DEFAULTS = {
  threshold: '30',
  interval: '120',
  'update-pattern': 'Update installed',
  'idle-pattern': 'new task\\?',
  'goal-pattern': '/goal active',
};

function fail(message) {
  process.stderr.write(`${message}\n${usage}\n`);
  process.exit(1);
}

let options;
try {
  ({ values: options } = parseArgs({
    options: {
      pattern: { type: 'string' },
      threshold: { type: 'string' },
      interval: { type: 'string' },
      'update-pattern': { type: 'string' },
      'idle-pattern': { type: 'string' },
      'goal-pattern': { type: 'string' },
      'no-update': { type: 'boolean' },
      'no-idle': { type: 'boolean' },
      'no-goal': { type: 'boolean' },
      start: { type: 'boolean', default: false },
      once: { type: 'boolean', default: false },
    },
  }));
} catch (error) {
  fail(error.message);
}

// 引数で渡されなかったものを config.local.json の watch、次に DEFAULTS で埋める。
// 数は JSON で数として書かれることもあるので、引数と同じ文字列に揃えてから検める。
const { config, error: configError } = loadConfig();
if (configError) fail(configError);
const watchConfig = config.watch ?? {};
if (typeof watchConfig !== 'object' || Array.isArray(watchConfig)) fail(`${CONFIG} の watch がオブジェクトではない`);
// エラーの文で出どころを示すため、config から埋めた値を覚えておく。
const fromConfig = new Set();
const source = (key) => (fromConfig.has(key) ? `${CONFIG} の watch.${key}` : `--${key}`);
for (const key of ['pattern', 'threshold', 'interval', 'update-pattern', 'idle-pattern', 'goal-pattern']) {
  if (options[key] !== undefined) continue;
  const value = watchConfig[key];
  if (value === undefined) {
    options[key] = DEFAULTS[key];
    continue;
  }
  if (typeof value !== 'string' && typeof value !== 'number') fail(`${CONFIG} の watch.${key} は文字列か数で書くこと`);
  options[key] = String(value);
  fromConfig.add(key);
}
// "true" のような文字列を黙って false と読むと、設定したつもりの値が効かない。
for (const key of ['no-update', 'no-idle', 'no-goal']) {
  if (options[key] !== undefined) continue;
  const value = watchConfig[key] === undefined ? false : watchConfig[key];
  if (typeof value !== 'boolean') fail(`${CONFIG} の watch.${key} は true か false で書くこと`);
  options[key] = value;
}
if (!options.pattern) {
  fail(`--pattern が無い。ステータスラインの使用率の表示に合わせて、引数で渡すか ${CONFIG} の watch.pattern に書くこと（形は config.example.json）`);
}

function compile(flag, text) {
  try {
    return new RegExp(text);
  } catch (error) {
    fail(`${flag} を正規表現として読めない: ${error.message}`);
  }
}
const pattern = compile(source('pattern'), options.pattern);
// キャプチャが無いと、どのペインも読めない扱いになる。
if (new RegExp(`${options.pattern}|`).exec('').length < 2) fail(`${source('pattern')} に使用率を取るキャプチャが無い`);
const updatePattern = options['no-update'] ? null : compile(source('update-pattern'), options['update-pattern']);
const idlePattern = options['no-idle'] ? null : compile(source('idle-pattern'), options['idle-pattern']);
const goalPattern = options['no-goal'] ? null : compile(source('goal-pattern'), options['goal-pattern']);

// 空文字は Number('') が 0 になって通ってしまうので、数の形をしているものだけ受ける。
const toNumber = (text) => (/^\s*\d+(\.\d+)?\s*$/.test(text) ? Number(text) : NaN);
const threshold = toNumber(options.threshold);
const interval = toNumber(options.interval);
// setTimeout は 2^31-1 ms を越えるとあふれて、ほぼ間を置かずに読み続ける。
const MAX_INTERVAL = Math.floor((2 ** 31 - 1) / 1000);
if (!Number.isFinite(threshold)) fail(`${source('threshold')} は数で渡すこと`);
if (!(interval > 0 && interval <= MAX_INTERVAL)) fail(`${source('interval')} は 0 より大きく ${MAX_INTERVAL} 以下の秒数で渡すこと`);

// 続けて読めなかった回数がこれに達したら WARN を出す。
// ペインが狭くて表示が切れる、といった一時的なものは数回で戻る。
// 戻らないならステータスラインの形が変わっている。黙っていると、閾値以上になっても永久に知らせない。
// blocked（承認や選択式の問いの待ち）はダイアログがステータスラインを隠すので数えない。
// 答えを待つ間は依頼も打ち込めないので、読めなくても失うものは無い。
const MISS_LIMIT = 3;

const emit = (...columns) => process.stdout.write(`${columns.join('\t')}\n`);
const clean = (text) => String(text ?? '').replace(/[\t\n]/g, ' ');

const notified = new Set();
const updated = new Set();
const idled = new Set();
const warned = new Set();
const misses = new Map();
let listFailures = 0;
let started = false;

// 入力欄の下枠より下は、ステータスラインと mode の行だけ（2.1.272 で実測。末尾の空行を入れて4行）。
// 画面全体に当てると、会話に映った別ペインの画面（herdr pane read の出力）の使用率を先に拾う。
const BELOW_BORDER_LIMIT = 8;

// エージェント一覧の行（AGENT_LIST_LINE）は、上限の数にも使用率の照合にも入れない。
// 照合からも外すのは、一覧に出るエージェントの作業内容に使用率らしき文字列が混ざったとき、
// それを自分の使用率と読まないため（ステータスラインが隠れていると、低い値を黙って返しうる）。
// 別ペインの画面を拾わない守りの本体は、行頭から始まる下枠のほう。この除外は上限を緩めるので、
// 字下げした丸印の多いツールの出力が下枠より下にあると、読めない扱いにならないことがある。

// 下枠より下の数行だけに当てる。
// 自分の入力欄が画面に無い（トランスクリプト表示や全面パネル）と、下枠の探索は会話まで上り、
// そこに映った別ペインの下枠を拾う。だから下が長すぎるときも読めない扱いにする。続けば WARN で気づける。
function readUsage(screen) {
  if (screen === null) return null;
  const lines = screen.split('\n');
  const bottom = bottomBorder(lines);
  if (bottom < 0) return null;
  const below = lines.slice(bottom + 1).filter((line) => !AGENT_LIST_LINE.test(line));
  if (below.length > BELOW_BORDER_LIMIT) return null;
  const captured = below.join('\n').match(pattern)?.[1];
  // 空のキャプチャを 0% と読むと、WARN も OVER も出なくなる。
  if (!captured) return null;
  const value = Number(captured);
  return Number.isFinite(value) ? value : null;
}

// 更新の知らせは、入力欄の上枠のすぐ上の行に右寄せで出る（2.1.272 で実測）。その1行だけを返す。
// 画面全体に当てると、会話に出てきた同じ文言（この見張りの話をしているときなど）を拾い、要らない再起動まで進む。
// 下から見て最初の「─ だけの行」を下枠、その上で最初の「─ で始まる行」を上枠とみなす。
// 入力欄の無い画面では '' か別の行を返しうる。そこに更新の文言がたまたま無ければ知らせは出ない。
function noticeRow(screen) {
  const lines = screen.split('\n');
  const bottom = bottomBorder(lines);
  // 入力欄の中身は複数行になりうるので、下枠から上枠まで遡る。
  for (let top = bottom - 1; top >= 1; top -= 1) {
    if (lines[top].startsWith('─')) return lines[top - 1];
  }
  return '';
}

function tick() {
  const agents = herdrJson(['agent', 'list'])?.result?.agents;
  if (!Array.isArray(agents)) {
    listFailures += 1;
    const reason = herdrError() || 'agents の一覧が出力に無い';
    if (options.once) {
      emit('WARN', clean(`Herdr のエージェント一覧を取れない（${reason}）`));
      process.exitCode = 1;
    } else if (listFailures === MISS_LIMIT) {
      emit('WARN', clean(`Herdr のエージェント一覧を ${MISS_LIMIT} 回続けて取れない（${reason}）`));
    }
    return;
  }
  listFailures = 0;

  const claudes = agents.filter((agent) => agent.agent === 'claude' && agent.pane_id);
  const readings = [];
  const events = [];
  let read = 0;
  for (const agent of claudes) {
    const label = clean(agent.terminal_title_stripped || agent.name || agent.pane_id);
    const id = agent.agent_session?.value || '';
    // 重複除けのキー。ID が空のペインはペインIDで代える（空文字のままだと全ペインで重なる）。
    const key = id || `pane:${agent.pane_id}`;
    const where = [agent.pane_id, clean(agent.name || '-'), label, clean(id || '-'), clean(agent.cwd)];

    // blocked のペインには依頼が届かないので、何も出さない。1回しか出さないので、ここで使い切らない。
    if (agent.agent_status === 'blocked') {
      readings.push(`${label}=blocked`);
      continue;
    }

    const screen = readScreen(agent.pane_id);

    const row = screen !== null && (updatePattern || idlePattern || goalPattern) ? noticeRow(screen) : '';

    // /goal（自律的な目標追従モード）が動いている間は、区切りの確認で割り込まない。
    // notified/updated/idled のどれにも加えないので、枠が外れれば次の tick でまた判定される。
    if (goalPattern && goalPattern.test(row)) {
      read += 1;
      readings.push(`${label}=goal`);
      continue;
    }

    // 放置のヒントが出ているペインは、IDLE だけを出す。IDLE は資料を書かせずに /clear する手順で、
    // OVER・UPDATE の区切りの確認を先に頼むと、冷えたキャッシュに大きな会話を読ませる割高な処理が走って手遅れになる。
    // /clear で会話が消えれば OVER は無意味になり、UPDATE の知らせは新しいセッションで改めて出る。
    const idleHit = idlePattern && !idled.has(key) && idlePattern.test(row);
    if (idleHit) {
      idled.add(key);
      updated.add(key);
      notified.add(key);
      events.push(['IDLE', clean(row.trim()), ...where]);
    } else if (updatePattern && !updated.has(key) && updatePattern.test(row)) {
      updated.add(key);
      events.push(['UPDATE', clean(row.trim()), ...where]);
    }

    const used = readUsage(screen);
    if (used === null) {
      readings.push(`${label}=?`);
      const count = (misses.get(key) ?? 0) + 1;
      misses.set(key, count);
      if (count >= MISS_LIMIT && !warned.has(key)) {
        warned.add(key);
        events.push(['WARN', `${label} の使用率を ${MISS_LIMIT} 回続けて読めない（${agent.pane_id}）`]);
      }
      continue;
    }
    misses.delete(key);
    read += 1;
    readings.push(`${label}=${used}%`);

    if (used >= threshold && !notified.has(key)) {
      notified.add(key);
      events.push(['OVER', `${used}%`, ...where]);
    }
  }

  // START を先に出す。読み手は START で見張りが動き出したと知ってから、個々の知らせを扱う。
  if (!started) {
    started = true;
    if (options.start) emit('START', `${threshold}%`, `${read}/${claudes.length}`, readings.join(' '));
  }
  for (const columns of events) emit(...columns);
}

tick();

// 待ちは setTimeout で。Atomics.wait で止めると、macOS ではパイプへの書き込みが非同期なので
// 出したはずの行が流れず、Monitor に届かない。同じ理由で --once も process.exit を呼ばずに自然に終える。
if (!options.once) {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    tick();
  }
}
