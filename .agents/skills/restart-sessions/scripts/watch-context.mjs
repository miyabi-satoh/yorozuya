#!/usr/bin/env node
// 各 claude ペインのステータスラインからコンテキストの使用率を読み、閾値を越えたら1行出す。
// 指定があれば、Claude Code の更新の知らせ（再起動で反映される）が出ているペインも1行出す。
// usage: watch-context.mjs --pattern <正規表現> [--threshold 50] [--interval 120] [--update-pattern <正規表現>] [--once]
//
// 出すのは「聞きに行くきっかけ」だけ。区切りかどうか、再起動するかは読んだ側と対象が決める。
// 画面からの読み取りで後戻りできない操作まで進めない。読み違えても、依頼が早いか遅いかで済むようにする。
//
// stdout の1行が1件の知らせ（Monitor で受ける前提）。列はタブ区切り。最初の回は START を先頭に出す。
//   START   <閾値>  <読めたペイン>/<claude ペイン>  <名前=使用率 …>（blocked のペインは 名前=blocked）
//   OVER    <使用率>  <pane_id>  <Herdr 名|->  <端末タイトル>  <セッションID>  <cwd>
//   UPDATE  <知らせの行>  <pane_id>  <Herdr 名|->  <端末タイトル>  <セッションID>  <cwd>
//   WARN    <何が起きたか>
// OVER・UPDATE と WARN（ペインごと）はセッションIDごとに1回だけ出す。再起動すればIDが変わるので、また出る。
// 覚えているのはこのプロセスの中だけ。走らせ直すと、閾値を越えたままのセッションにもう一度出る。
//
// --pattern はステータスラインの表示に合わせる。使用率の数字を1つ目のキャプチャで取る。
// 例: 'Ctx Used: ([\d.]+)%'
// --update-pattern は更新の知らせの文言に合わせる。省けば更新は見ない。
// 例: 'Update installed'（Claude Code 2.1.272 では「Update installed · Restart to update」か「… Restart to apply」）

import { parseArgs } from 'node:util';
import { herdr, herdrError, herdrJson } from './lib/herdr.mjs';

const usage = 'usage: watch-context.mjs --pattern <正規表現> [--threshold 50] [--interval 120] [--update-pattern <正規表現>] [--once]';

let options;
try {
  ({ values: options } = parseArgs({
    options: {
      pattern: { type: 'string' },
      threshold: { type: 'string', default: '50' },
      interval: { type: 'string', default: '120' },
      'update-pattern': { type: 'string' },
      once: { type: 'boolean', default: false },
    },
  }));
} catch (error) {
  process.stderr.write(`${error.message}\n${usage}\n`);
  process.exit(1);
}

if (!options.pattern) {
  process.stderr.write(`${usage}\n`);
  process.exit(1);
}
function compile(flag, source) {
  try {
    return new RegExp(source);
  } catch (error) {
    process.stderr.write(`${flag} を正規表現として読めない: ${error.message}\n`);
    process.exit(1);
  }
}
const pattern = compile('--pattern', options.pattern);
const updatePattern = options['update-pattern'] ? compile('--update-pattern', options['update-pattern']) : null;
const threshold = Number(options.threshold);
const interval = Number(options.interval);
// Infinity を通すと setTimeout があふれて、ほぼ間を置かずに読み続ける。
if (!Number.isFinite(threshold) || !Number.isFinite(interval) || !(interval > 0)) {
  process.stderr.write(`--threshold と --interval は数で渡すこと\n${usage}\n`);
  process.exit(1);
}

// 続けて読めなかった回数がこれに達したら WARN を出す。
// ペインが狭くて表示が切れる、といった一時的なものは数回で戻る。
// 戻らないならステータスラインの形が変わっている。黙っていると、閾値を越えても永久に知らせない。
// blocked（承認や選択式の問いの待ち）はダイアログがステータスラインを隠すので数えない。
// 答えを待つ間は依頼も打ち込めないので、読めなくても失うものは無い。
const MISS_LIMIT = 3;

const emit = (...columns) => process.stdout.write(`${columns.join('\t')}\n`);
const clean = (text) => String(text ?? '').replace(/[\t\n]/g, ' ');

const notified = new Set();
const updated = new Set();
const warned = new Set();
const misses = new Map();
let listFailures = 0;

function readScreen(pane) {
  const screen = herdr(['pane', 'read', pane, '--source', 'visible']);
  if (screen === null) return null;
  // ステータスラインの空白はノーブレークスペースで来ることがある（実測）。
  // 画面で見たとおり普通の空白で書いたパターンが当たるよう、揃えてから照合する。
  return screen.replace(/ /g, ' ');
}

function readUsage(screen) {
  if (screen === null) return null;
  const value = Number(screen.match(pattern)?.[1]);
  return Number.isFinite(value) ? value : null;
}

// 更新の知らせは、入力欄の上枠のすぐ上の行に右寄せで出る（2.1.272 で実測）。その1行だけを返す。
// 画面全体に当てると、会話に出てきた同じ文言（この見張りの話をしているときなど）を拾い、要らない再起動まで進む。
// 入力欄が見つからなければ '' を返す。形が変われば知らせが出なくなるだけで、再起動には進まない。
function noticeRow(screen) {
  const lines = screen.split('\n');
  let bottom = lines.length - 1;
  while (bottom >= 0 && !/^─+$/.test(lines[bottom].trim())) bottom -= 1;
  // 入力欄の中身は複数行になりうるので、下枠から上枠まで遡る。
  for (let top = bottom - 1; top >= 1; top -= 1) {
    if (lines[top].trimStart().startsWith('─')) return lines[top - 1];
  }
  return '';
}

function tick(first) {
  const agents = herdrJson(['agent', 'list'])?.result?.agents;
  if (!Array.isArray(agents)) {
    listFailures += 1;
    if (listFailures === MISS_LIMIT) emit('WARN', clean(`Herdr のエージェント一覧を ${MISS_LIMIT} 回続けて取れない（${herdrError()}）`));
    return;
  }
  listFailures = 0;

  const claudes = agents.filter((agent) => agent.agent === 'claude' && agent.pane_id);
  const readings = [];
  const events = [];
  let read = 0;
  for (const agent of claudes) {
    const label = clean(agent.terminal_title_stripped || agent.name || agent.pane_id);
    // 空文字の ID は全セッションで重なるので、ペインIDで代える。後で本物の ID が取れるとキーが変わり、知らせがもう一度出うる。
    const session = agent.agent_session?.value || agent.pane_id;
    const blocked = agent.agent_status === 'blocked';
    const screen = readScreen(agent.pane_id);

    // blocked のペインには依頼が届かないので、答えてもらってから出す。1回しか出さないので、ここで使い切らない。
    if (updatePattern && screen !== null && !blocked && !updated.has(session)) {
      const row = noticeRow(screen);
      if (updatePattern.test(row)) {
        updated.add(session);
        events.push(['UPDATE', clean(row.trim()), agent.pane_id, clean(agent.name || '-'), label, session, clean(agent.cwd)]);
      }
    }

    const used = readUsage(screen);
    if (used === null) {
      if (blocked) {
        readings.push(`${label}=blocked`);
        continue;
      }
      const count = (misses.get(session) ?? 0) + 1;
      misses.set(session, count);
      if (count >= MISS_LIMIT && !warned.has(session)) {
        warned.add(session);
        events.push(['WARN', `${label} の使用率を ${MISS_LIMIT} 回続けて読めない（${agent.pane_id}）`]);
      }
      continue;
    }
    misses.delete(session);
    read += 1;
    readings.push(`${label}=${used}%`);

    if (used >= threshold && !notified.has(session)) {
      notified.add(session);
      events.push(['OVER', `${used}%`, agent.pane_id, clean(agent.name || '-'), label, session, clean(agent.cwd)]);
    }
  }

  // START を先に出す。読み手は START で見張りが動き出したと知ってから、個々の知らせを扱う。
  if (first) emit('START', `${threshold}%`, `${read}/${claudes.length}`, readings.join(' '));
  for (const columns of events) emit(...columns);
}

tick(true);
if (options.once) process.exit(0);

// 待ちは setTimeout で。Atomics.wait で止めると、macOS ではパイプへの書き込みが非同期なので
// 出したはずの行が流れず、Monitor に届かない。
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  tick(false);
}
