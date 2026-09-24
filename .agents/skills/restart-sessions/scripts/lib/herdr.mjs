// Herdr の CLI を叩く。失敗は null で返し、判断は呼び出し側に残す。

import { spawnSync } from 'node:child_process';

let lastError = '';

export function herdrError() {
  return lastError.trim();
}

export function herdr(args) {
  const result = spawnSync('herdr', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) {
    lastError = String(result.error.message ?? result.error);
    return null;
  }
  if (result.status !== 0) {
    lastError = result.stderr ?? '';
    return null;
  }
  lastError = '';
  return result.stdout;
}

export function herdrJson(args) {
  const out = herdr(args);
  if (out === null) return null;
  try {
    return JSON.parse(out);
  } catch {
    // ここで黙って null を返すと、herdr() が成功時に空にした lastError がそのまま残り、
    // 呼び出し側の「（理由）」が空括弧になる。読めなかったこと自体を理由にする。
    lastError = `herdr の出力を JSON として読めない: ${out.trim().slice(0, 200)}`;
    return null;
  }
}

// 直近のエラーの code。Herdr は失敗時に {"error":{"code":...}} を stderr に出す。
// stderr 全文への部分一致で判定すると、message に紛れた語を拾って誤判定する。
export function herdrErrorCode() {
  try {
    return JSON.parse(lastError)?.error?.code ?? '';
  } catch {
    return '';
  }
}

// agent prompt がこれらを返したときは、入力を送る前に弾かれている。
// agent_blocked と agent_not_ready は Herdr の文書に「入力を送る前に弾く」とある。
// agent_not_found と empty_agent_prompt は実測した。server_not_running は、サーバが
// 動いていないなら何も届いていない。
// ここに無いコードは「送られたかもしれない」側として扱う（呼び出し側で FAIL にする）。
export const SEND_REFUSED = new Set([
  'agent_blocked',
  'agent_not_ready',
  'agent_not_found',
  'empty_agent_prompt',
  'pane_not_found',
  'server_not_running',
]);

// 入力欄に打ち込む。`/exit` や `@<資料>` など、スラッシュコマンドや特殊な参照記法を
// 確実に効かせるにはこの経路が要る（クロスセッションのメッセージは普通のテキストとして届く）。
// 承認・質問ダイアログで止まっている相手は Herdr が agent_blocked で弾く（入力は送られない）。
export function prompt(target, text) {
  return herdr(['agent', 'prompt', target, text]) !== null;
}

// 前景のプロセスグループがシェルに戻っていれば、そのペインの claude は終了している。
// どちらのフィールドも schema 上は省略も null もありうる（required は pane_id だけ）。
// 欠けたまま比べると undefined === undefined で「戻った」ことになってしまうので、
// 両方が整数のときだけ判定する。claude が走っている最中に起動へ進むと、取り返しがつかない。
export function shellIsBack(pane) {
  const info = herdrJson(['pane', 'process-info', '--pane', pane])?.result?.process_info;
  if (!info) return false;
  const group = info.foreground_process_group_id;
  const shell = info.shell_pid;
  if (!Number.isInteger(group) || !Number.isInteger(shell)) return false;
  return group === shell;
}

// agent get の結果そのまま。種別・名前・セッションIDをまとめて照合したいときに使う。
// 取得できなければ null。
export function agentInfo(target) {
  return herdrJson(['agent', 'get', target])?.result?.agent ?? null;
}

export function agentStatus(pane) {
  return agentInfo(pane)?.agent_status ?? '';
}

// 画面を読む。ステータスラインの空白はノーブレークスペースで来ることがある（実測）。
// 画面で見たとおり普通の空白で書いたパターンが当たるよう、揃えてから返す。
export function readScreen(pane) {
  const screen = herdr(['pane', 'read', pane, '--source', 'visible']);
  if (screen === null) return null;
  return screen.replace(/\u00a0/g, ' ');
}

// 入力欄の下枠: 下から見て最初の「行頭から ─ だけの行」。見つからなければ -1。
// 行頭を見るのは、会話に映った別ペインの画面（herdr pane read の出力）の枠を拾わないため。
// ツールの出力は字下げして表示されるので、その中の枠は行頭から始まらない。
export function bottomBorder(lines) {
  let index = lines.length - 1;
  while (index >= 0 && !/^─+\s*$/.test(lines[index])) index -= 1;
  return index;
}

// バックグラウンドのエージェントを走らせている間は、ステータスラインの下に一覧が並ぶ（2.1.274 で実測と同梱コード）。
// 行頭は `❯ ` か空白2つ、入れ子なら `├ `・`└ ` が続き、丸印は `⏺`（macOS 以外は `●`）か `◯`。
// 例: `  ⏺ main`、`  ◯ general-purpose …`、`❯ ◯ …`、`    └ ◯ …`。
// ステータスラインの行（`  Model: … | Ctx Used: … | …`）やモードラインはこのパターンに当たらない。
export const AGENT_LIST_LINE = /^(?:❯|\s)\s*(?:[├└]\s)?[⏺●◯]\s/;

// モードライン（`⏵⏵ auto mode on · 1 monitor · ← for agents` の形）から
// バックグラウンドのシェル・Monitor の数を読む。自己申告（「バックグラウンド処理はありません」）が
// 実際のハーネスの追跡と食い違うことがある（2026-09-11 に別プロジェクトで起きた事故と同種）ため、
// /exit の前にここで機械的に照合する。
// 入力欄の下枠より下を、エージェント一覧の行を除いてすべて見る。一覧はモードラインの下に並ぶので、
// 末尾の数行だけを見ると押し出される。モードの名前（auto・accept edits など）には頼らない。
// 見つからなければ null（バックグラウンド無し、または読めなかった。呼び出し側は SKIP にしない）。
// 実測: 2026-09-23・2026-09-24 に「1 monitor」「1 shell」「2 shells」を確認。
export function backgroundWorkHint(pane) {
  const screen = readScreen(pane);
  if (screen === null) return null;
  const lines = screen.split('\n');
  const bottom = bottomBorder(lines);
  if (bottom < 0) return null;
  for (const line of lines.slice(bottom + 1)) {
    if (AGENT_LIST_LINE.test(line) || !line.includes(' · ')) continue;
    const total = [...line.matchAll(/(\d+)\s+(?:shells?|monitors?|tasks?)\b/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    if (total > 0) return line.trim();
  }
  return null;
}

// 名前が空いていれば ''、握られていればそのペインID、一覧が取れなければ null。
// 呼び出し側は null を「空き」と混ぜないこと。混ぜると一過性のエラーで待ちを打ち切る。
export function paneHoldingName(name) {
  const agents = herdrJson(['agent', 'list'])?.result?.agents;
  // 形が変わって配列でなければ、.find() が例外を投げて後片付けの途中で落ちる。取得失敗と同じ扱いにする。
  if (!Array.isArray(agents)) return null;
  return agents.find((agent) => agent.name === name)?.pane_id ?? '';
}

export function startAgent(name, pane) {
  return herdr(['agent', 'start', name, '--kind', 'claude', '--pane', pane, '--timeout', '60000']) !== null;
}

// Herdr のエージェント名の規則。後戻りできない操作の前に確かめる。
export const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

const slot = new Int32Array(new SharedArrayBuffer(4));
export function sleep(seconds) {
  Atomics.wait(slot, 0, 0, seconds * 1000);
}

// 名前が空くまで待つ。Herdr は閉じたペインの名前をすぐ外すとは限らない。
// 空いたら true。取得できない回は「空き」と見なさず待ち続ける。
export function waitForNameRelease(name, seconds) {
  for (let i = 0; i < seconds; i += 1) {
    if (paneHoldingName(name) === '') return true;
    sleep(1);
  }
  return paneHoldingName(name) === '';
}
