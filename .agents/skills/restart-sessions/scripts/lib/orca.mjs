// Orca の CLI を叩く。herdr.mjs と同じく、失敗は null で返し、判断は呼び出し側に残す。
// Orca は 1.4.268 で確かめた。--json の出力は { ok, result } か { ok: false, error: { code } } で、失敗も stdout に出る。
//
// Herdr と違い、Orca は claude のセッションIDと名前を持たない（agent list の orcaSessionId は Orca の ID で、/clear で変わる）。
// セッションIDと名前は Claude Code の登録簿（<設定のフォルダー>/sessions/<pid>.json）から引き、端末とは端末のタイトルで結ぶ。
// claude は自分のセッションの名前を端末のタイトルに出す（`✳ knowledge-10/mac` のように、頭に状態の印が付く）。

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { backgroundHintFromScreen, bottomBorder, draftFromScreen, draftIsRequest } from './herdr.mjs';

let lastError = '';
let lastCode = '';

export function orcaError() {
  return lastError.trim();
}

export function orcaErrorCode() {
  return lastCode;
}

// 出力の JSON を読む。読めなければ null。CLI が失敗しても JSON は stdout に出るので、終了コードより先に中身を見る。
export function parseOrcaOutput(stdout) {
  try {
    const data = JSON.parse(stdout);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

// 成功なら result、失敗なら null。失敗の理由は orcaError()・orcaErrorCode() で読む。
export function orca(args) {
  const run = spawnSync('orca', [...args, '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  lastCode = '';
  if (run.error) {
    lastError = String(run.error.message ?? run.error);
    return null;
  }
  const data = parseOrcaOutput(run.stdout ?? '');
  if (data?.ok === true && run.status === 0) {
    lastError = '';
    return data.result ?? {};
  }
  lastCode = data?.error?.code ?? '';
  lastError = data?.error?.message ?? (run.stderr || run.stdout || `orca の終了コード ${run.status}`);
  return null;
}

// --- 画面 ---

// 同じ読み方を mod（mod/hooks/register.ts の orcaScreenOf）と heavy-task の run-in-tab.mjs も持つ。変えるときはそちらも直す。
// terminal read --screen の結果から画面の文字を作る。空白がノーブレークスペースで来ても揃える（herdr.mjs の readScreen と同じ）。
// --screen で頼んでも描けなかったとき（source が screen-unavailable）は、流れた出力の積み重ねで、画面とは別物なので読めない扱いにする。
export function screenFromRead(result) {
  const terminal = result?.terminal;
  if (!Array.isArray(terminal?.tail)) return null;
  if (terminal.source !== undefined && terminal.source !== 'screen') return null;
  return terminal.tail.join('\n').replace(/\u00a0/g, ' ');
}

function readResult(handle) {
  return orca(['terminal', 'read', '--terminal', handle, '--screen']);
}

export function readScreen(handle) {
  return screenFromRead(readResult(handle));
}

// 入力欄の書きかけ。Orca は claude の入力欄の書きかけを draft に分けて返し、画面（tail）からは外す（実測）。
// 薄字の案内（`Try "…"`）は draft に入らず、画面にそのまま残る。
// draft が無いときは画面の入力欄も見る。Orca が claude と見分けられず draft に分けなかった書きかけを見逃さないため。
// 画面には色が無く薄字を見分けられないので、案内の形のものだけを空とみなし、ほかは書きかけとして止まる側に倒す。
export function draftFromRead(result) {
  const draft = result?.terminal?.draft;
  if (typeof draft === 'string' && draft.trim() !== '') return draft.trim();
  const screen = screenFromRead(result);
  if (screen === null) return null;
  // 枠の探し方は herdr.mjs の draftFromScreen と同じ。色の無い画面では、そのまま全部の文字を書きかけと読む。
  const text = draftFromScreen(screen);
  return text !== null && /^Try ".*"$/.test(text) ? '' : text;
}

export function inputDraft(handle) {
  const result = readResult(handle);
  return result === null ? null : draftFromRead(result);
}

// 読み方は herdr.mjs の backgroundWorkHint と同じ。
export function backgroundWorkHint(handle) {
  return backgroundHintFromScreen(readScreen(handle));
}

// --- 端末とエージェント ---

export function terminalInfo(handle) {
  return orca(['terminal', 'show', '--terminal', handle])?.terminal ?? null;
}

// claude が端末のタイトルの頭に付ける状態の印と、続く空白。見たのは ✳・◐・◑（2.1.330）。回る印の残りの形（◒・◓・✻ など・点字の回る印）も入れる。
// 知っている印だけを外す。記号で始まる名前（`_wip` など）を削って、別の名前と読まないため。
const STATUS_GLYPH = /^[✳✻✽✶✢·◐◑◒◓\u2800-\u28ff]\s+/u;

export function stripTitle(title) {
  return String(title ?? '')
    .trim()
    .replace(STATUS_GLYPH, '')
    .trim();
}

// agent list の state。端末とは paneKey（<tabId>:<leafId>）で結ぶ。claude がまだ Orca に知らせていなければ載らず ''。
// state は working・blocked・waiting・done（orca agent list --help）。
export function agentStateOf(agents, terminal) {
  if (!Array.isArray(agents) || !terminal?.tabId || !terminal?.leafId) return '';
  return agents.find((agent) => agent?.paneKey === `${terminal.tabId}:${terminal.leafId}`)?.state ?? '';
}

export function agentList() {
  const agents = orca(['agent', 'list'])?.agents;
  return Array.isArray(agents) ? agents : null;
}

export function agentState(handle) {
  return agentStateOf(agentList(), terminalInfo(handle));
}

// --- Claude Code の登録簿 ---

const sessionsDir = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'sessions');

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // 別のユーザーのプロセスは EPERM で、生きている。
    return error.code === 'EPERM';
  }
}

// pid が claude のプロセスか。落ちた claude の登録が残り、その pid が別のプロセスに使い回されていても、生きた claude と見ないため。
// ps（Windows は tasklist）でまとめて見る。見られなければ null（呼び出し側は pid が生きていることだけで信じる）。
// Windows は claude.exe だけ（Windows のマシンで実際の名前を確かめた）。
export function claudePids(pids) {
  const alive = pids.filter(pidAlive);
  if (alive.length === 0) return new Set();
  const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  try {
    if (process.platform === 'win32') {
      const found = new Set();
      for (const line of run('tasklist', ['/FO', 'CSV', '/NH']).split(/\r?\n/)) {
        const [image, pid] = line.split('","').map((cell) => cell.replace(/"/g, ''));
        if (/^claude\.exe$/i.test(image ?? '') && alive.includes(Number(pid))) found.add(Number(pid));
      }
      return found;
    }
    const list = alive.join(',');
    return claudePidsFromPs(run('ps', ['-o', 'pid=,comm=', '-p', list]), run('ps', ['-o', 'pid=,args=', '-p', list]));
  } catch {
    return null;
  }
}

// `ps -o pid=,comm=` と `ps -o pid=,args=` の出力から claude の pid を拾う。
// コマンドの名前（comm）が claude か、コマンドの頭の語が claude か、`node …/claude …`（npm で入れた版）なら claude。
export function claudePidsFromPs(commOut, argsOut = '') {
  const found = new Set();
  const isClaude = (word) => /(^|[\\/])claude(\.exe)?$/i.test(word ?? '');
  for (const line of commOut.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (match && isClaude(match[2].trim())) found.add(Number(match[1]));
  }
  for (const line of argsOut.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const [command, script] = match[2].split(/\s+/);
    if (isClaude(command) || (/(^|[\\/])node(\.exe)?$/i.test(command) && isClaude(script))) found.add(Number(match[1]));
  }
  return found;
}

// 生きている claude の登録を全部。読めない登録は飛ばす。
export function liveSessions() {
  let names;
  try {
    names = readdirSync(sessionsDir()).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    try {
      const entry = JSON.parse(readFileSync(join(sessionsDir(), name), 'utf8'));
      if (Number.isInteger(entry?.pid) && typeof entry.sessionId === 'string') entries.push(entry);
    } catch {
      // 書きかけ・消えかけの登録は飛ばす。
    }
  }
  // ps・tasklist が使えないときだけ、生きていることだけで信じる。見分けられたうえで1つも claude でなければ、どれも生きていない。
  // 見分けられたうえで1つも claude でないときに pid が生きていることで信じ直さないのは、落ちた claude の登録の pid が
  // 別のプロセスに使い回されると、生きたセッションに見えるため。claude の見分け方は macOS（`…/claude` で始まる args）と
  // Windows（claude.exe）で確かめてある。
  const claudes = claudePids(entries.map((entry) => entry.pid));
  if (claudes === null) return entries.filter((entry) => pidAlive(entry.pid));
  return entries.filter((entry) => claudes.has(entry.pid));
}

export function sessionOfPid(pid) {
  return liveSessions().find((entry) => entry.pid === pid) ?? null;
}

// タイトルに当たる登録の全部（作業フォルダーで絞る前）。名前そのものに当たるものがあれば、それだけ。
export function sessionsForTitle(sessions, title) {
  const name = stripTitle(title);
  if (!name) return [];
  const named = sessions.filter((entry) => typeof entry.name === 'string' && entry.name);
  const exact = named.filter((entry) => name === entry.name);
  return exact.length > 0 ? exact : named.filter((entry) => name.startsWith(`${entry.name}/`) && /^[\w.-]+$/.test(name.slice(entry.name.length + 1)));
}

// 端末のタイトルに当たる登録。タイトルは名前そのもの（`knowledge-10/mac`）か、名前に `/<マシン>` を足したもの
// （登録の名前が `orca-scratch-68`、タイトルが `orca-scratch-68/mac`）がある（どちらも実測）。
// 名前そのものに当たるものを先にする。`/<マシン>` の形は、マシンの名前に `/` を含まないものだけ（`foo` が `foo/bar/baz` に当たらないため）。
// 1つに決まらなければ cwd が端末の作業フォルダーと同じものに絞り、それでも決まらなければ null（取り違えて別のセッションを止めないため）。
export function sessionForTitle(sessions, title, worktreePath) {
  const hits = sessionsForTitle(sessions, title);
  if (hits.length === 1) return hits[0];
  const here = hits.filter((entry) => entry.cwd === worktreePath);
  return here.length === 1 ? here[0] : null;
}

// 呼び出し元自身。端末は ORCA_TERMINAL_HANDLE、claude は CLAUDE_PID（Bash ツールの子）か親のプロセスで引く。
// どちらでも引けなければ（mod からシェルを挟んで呼ばれたときなど）、自分の端末のタイトルで引く。
// 端末が無ければ null、claude が引けなければ entry が null。
export function selfSession() {
  const handle = process.env.ORCA_TERMINAL_HANDLE ?? '';
  if (!handle) return null;
  const pids = [Number(process.env.CLAUDE_PID), process.ppid];
  let entry = pids.map((pid) => sessionOfPid(pid)).find(Boolean) ?? null;
  if (!entry) {
    const terminal = terminalInfo(handle);
    if (terminal) entry = sessionForTitle(liveSessions(), terminal.title, terminal.worktreePath);
  }
  return { handle, entry };
}

// 端末ごとの claude。見張り（watch-context.mjs）が読む形にそろえる。一覧が取れなければ null。
// agentIdentity は claude が終わった後も claude のまま残る（実測）ので、登録簿に当たる生きた claude があるものだけにする。
export function claudeTerminals() {
  const terminals = orca(['terminal', 'list'])?.terminals;
  if (!Array.isArray(terminals)) return null;
  const agents = agentList() ?? [];
  const sessions = liveSessions();
  return claudeTerminalsFrom(terminals, agents, sessions);
}

export function claudeTerminalsFrom(terminals, agents, sessions) {
  const found = [];
  for (const terminal of terminals) {
    if (terminal?.agentIdentity !== 'claude' || terminal.connected === false || !terminal.handle) continue;
    const entry = sessionForTitle(sessions, terminal.title, terminal.worktreePath);
    if (!entry) continue;
    found.push({
      id: terminal.handle,
      name: stripTitle(terminal.title),
      label: stripTitle(terminal.title),
      sid: entry.sessionId,
      cwd: entry.cwd ?? terminal.worktreePath ?? '',
      pid: entry.pid,
      status: agentStateOf(agents, terminal),
    });
  }
  return found;
}

// 2つのフォルダーが同じか。実体のパスで比べる（macOS の /tmp と /private/tmp のような別名で食い違わないため）。
// Windows のパスは大文字と小文字を区別しない。どちらかが解決できなければ違うとみなす（止まる側に倒す）。
// macOS の大文字と小文字を区別しないボリュームでも書き分けは揃えない（実体のパスは登録されたときの書き方で返り、食い違えば SKIP で止まるだけのため）。
export function sameDir(a, b) {
  const real = (path) => {
    try {
      const resolved = realpathSync.native(path);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    } catch {
      return '';
    }
  };
  const left = a ? real(a) : '';
  return left !== '' && left === (b ? real(b) : '');
}

// restart-orca が元の端末を閉じてよいか。since は控えた位置から読み直した terminal（読めなければ null）、
// matches は元の端末の今のタイトルに当たる生きた登録（引けなければ null）、started は新しいセッションの登録。
// 控えた位置より後に文のある出力が無く、新しいセッションのほかに当たる claude が1つも無いときだけ閉じる。
export function mayCloseOldTerminal(since, matches, started) {
  if (!Array.isArray(since?.tail) || !since.tail.every((line) => line.trim() === '')) return false;
  if (!Array.isArray(matches)) return false;
  // 新しいセッションと見なすのは、pid が一致するものだけ（pid は新しい claude を起動して確かめた値）。
  // ID が欠けたもの同士（undefined === undefined）や、sessionId だけの一致で別の claude を見逃さないため。
  if (started?.pid == null) return false;
  return matches.every(
    (entry) => entry.pid === started.pid && (entry.sessionId == null || started.sessionId == null || entry.sessionId === started.sessionId),
  );
}

// 流れた出力の位置。数の形でなければ null（位置が分からないので、後から出たものを見分けられない）。
export function cursorOf(read) {
  const cursor = read?.terminal?.nextCursor;
  return (typeof cursor === 'string' || typeof cursor === 'number') && /^\d+$/.test(String(cursor)) ? String(cursor) : null;
}

// --- 入力 ---

// 入力欄に打ち込んで送る。claude と見分けた端末には、Orca が貼り付けとして入れてから Enter を送る。
// `/exit` や `/clear` も貼り付けで効く（実測）。
export function prompt(handle, text) {
  return orca(['terminal', 'send', '--terminal', handle, '--text', text, '--enter']) !== null;
}

export function pressEnter(handle) {
  return orca(['terminal', 'send', '--terminal', handle, '--enter']) !== null;
}

// send の結果の stages に turn_started があれば、送った文でターンが始まったのを Orca が見ている。
export function sendStarted(result) {
  const stages = result?.send?.prompt?.stages;
  return Array.isArray(stages) && stages.includes('turn_started');
}

// このコードのときは、端末に何も届いていない（古いハンドル。実測）。ここに無いコードは「届いたかもしれない」側に置く。
export const SEND_REFUSED = new Set(['terminal_handle_stale']);

const slot = new Int32Array(new SharedArrayBuffer(4));
export function sleep(seconds) {
  Atomics.wait(slot, 0, 0, seconds * 1000);
}

// 送った文が会話に出ているか（入力欄より上に、空白を除いた頭の 40 字があるか）。短いターンは確かめる前に終わり、
// working を見られないことがある。送った直後の --wait-submit も、ターンが始まっても turn_started を返さないことがある（どちらも実測）。
export function submittedOnScreen(screen, text) {
  if (screen === null) return false;
  const lines = screen.split('\n');
  const bottom = bottomBorder(lines);
  if (bottom < 0) return false;
  let top = bottom - 1;
  while (top >= 0 && !lines[top].startsWith('─')) top -= 1;
  const squash = (value) => value.replace(/\s+/g, '');
  const head = squash(text).slice(0, 40);
  return head.length > 0 && squash(lines.slice(0, Math.max(top, 0)).join('\n')).includes(head);
}

// herdr.mjs の submitAndConfirm と同じ返し方。送った後に動き出したか、会話に出たのを見る。
// 入力欄に依頼だけが残っていれば Enter を1回送り直して確かめる。
export function submitAndConfirm(handle, text, timeoutMs = 30000) {
  // 起動の処理が動いている間に送らないよう、画面が落ち着くのを先に待つ。取れなくても送りはする。
  orca(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', '10000']);
  const seconds = String(Math.max(1, Math.round(timeoutMs / 1000)));
  const sent = orca(['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--wait-submit', seconds]);
  if (sent === null) {
    if (SEND_REFUSED.has(orcaErrorCode())) return { result: 'refused', detail: orcaError() };
    return { result: 'unknown', detail: orcaError() };
  }
  if (sendStarted(sent)) return { result: 'started' };
  const took = () => ['working', 'blocked'].includes(agentState(handle)) || submittedOnScreen(readScreen(handle), text);
  if (took()) return { result: 'started' };
  const draft = inputDraft(handle);
  if (!draftIsRequest(draft, text)) {
    const detail =
      draft === null ? '動き出さず、入力欄も読めない' : draft === '' ? '動き出さず、入力欄は空' : `動き出さず、入力欄に依頼と違う文がある: ${draft.slice(-80)}`;
    return { result: 'unknown', detail };
  }
  if (!pressEnter(handle)) return { result: 'unknown', detail: `Enter を送れない（${orcaError()}）` };
  for (let i = 0; i < timeoutMs / 1000; i += 1) {
    sleep(1);
    if (took()) return { result: 'resent' };
  }
  return { result: 'unknown', detail: '入力欄に残った依頼へ Enter を送り直しても動き出さない' };
}

// シェルに打った claude が上がるのを待つ。上がった claude は端末のタイトルに名前を出し、登録簿に載る。
// 前の claude（exceptPid）は数えない。上がったら登録を、時間内に上がらなければ null を返す。
// フォルダーの信頼などのダイアログで止まっていると、タイトルが変わらず null になる（呼び出し側は端末を閉じずに止まる）。
export function waitForClaude(handle, seconds, exceptPid) {
  for (let i = 0; i < seconds; i += 1) {
    sleep(1);
    const terminal = terminalInfo(handle);
    if (!terminal) continue;
    const entry = sessionForTitle(liveSessions(), terminal.title, terminal.worktreePath);
    if (entry && entry.pid !== exceptPid && bottomBorder((readScreen(handle) ?? '').split('\n')) >= 0) return entry;
  }
  return null;
}

