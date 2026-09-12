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

// 入力欄に打ち込む。スラッシュコマンドを呼ばせるにはこの経路が要る
// （handoff スキルは disable-model-invocation で、メッセージからは呼べない）。
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
