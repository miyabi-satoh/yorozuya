// herdr-core（hc）の CLI を叩く。herdr.mjs・orca.mjs と同じく、失敗は null で返し、判断は呼び出し側に残す。
// hc は 0.1.21 で確かめた。--json の出力は、成功なら結果そのものが stdout に、失敗なら {"error":{"kind","message"}} が stderr に出る。
//
// 端末は address（`t7`）で指す。名前でも引けるが、終わった端末の名前は外れて別の新しい端末が使えるので（実測）、引いた後は address を使う。
// claude のセッションIDは、claude の SessionStart の hook が端末のラベル claude_transcript に書く会話の記録のパス（`<セッションID>.jsonl`）から取る。
// hook は起動・/clear・再開のたびに書き直すので、/clear の後も今のセッションを指す。

import { spawnSync } from 'node:child_process';

import { backgroundHintFromScreen, draftFromScreen } from './herdr.mjs';

let lastError = '';
let lastKind = '';

export function hcError() {
  return lastError.trim();
}

export function hcErrorKind() {
  return lastKind;
}

// stderr の {"error":{...}} を読む。読めなければ null。
export function parseHcError(stderr) {
  try {
    const error = JSON.parse(stderr)?.error;
    return error && typeof error === 'object' ? error : null;
  } catch {
    return null;
  }
}

// 成功なら出力の JSON、失敗なら null。--json はサブコマンドの直後に置く（引数の後ろに置くと、`--` の後の文として渡ってしまう）。
export function hc(args, { env } = {}) {
  const run = spawnSync('hc', [args[0], '--json', ...args.slice(1)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: env ?? process.env });
  lastKind = '';
  if (run.error) {
    lastError = String(run.error.message ?? run.error);
    return null;
  }
  if (run.status === 0) {
    try {
      const data = JSON.parse(run.stdout);
      lastError = '';
      return data ?? {};
    } catch {
      lastError = `hc の出力を JSON として読めない: ${String(run.stdout).trim().slice(0, 200)}`;
      return null;
    }
  }
  const error = parseHcError(run.stderr ?? '');
  lastKind = error?.kind ?? '';
  lastError = error?.message ?? (run.stderr || run.stdout || `hc の終了コード ${run.status}`);
  return null;
}

// --- 端末 ---

export const selfId = () => process.env.HC_TERMINAL_ID ?? '';

export function terminalInfo(t) {
  return hc(['get', t]);
}

// status は claude が OSC 7501 で知らせる語（idle・working・done・blocked・error）。知らせていなければ ''。
export function statusOf(info) {
  const status = info?.status;
  return typeof status === 'string' ? status : (status?.state ?? '');
}

export function agentStatus(t) {
  return statusOf(terminalInfo(t));
}

// ラベル claude_transcript のパスの末尾からセッションIDを取る。Windows のマシンのパス（`C:\…\x.jsonl`）も分ける。
export function sessionIdOf(info) {
  const path = info?.labels?.claude_transcript;
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) return '';
  return path.split(/[\\/]/).pop().slice(0, -'.jsonl'.length);
}

// 今その端末の前に出ているのが claude か。claude が終わってシェルに戻ると、ラベルは残るが前景はシェルになる。
// 見分け方は orca.mjs の claudePidsFromPs と同じ（名前が claude か、`node …/claude …`）。
export function isClaude(info) {
  if (info?.state !== 'live') return false;
  const fg = info.foreground;
  const named = (word) => /(^|[\\/])claude(\.exe)?$/i.test(word ?? '');
  if (named(fg?.name) || named(fg?.argv?.[0])) return true;
  return /(^|[\\/])node(\.exe)?$/i.test(fg?.argv?.[0] ?? '') && named(fg?.argv?.[1]);
}

// claude の今の作業フォルダー。前景のプロセスの cwd（OS から引いたもの）を先にし、無ければ端末を作ったときの cwd。
export function cwdOf(info) {
  return [info?.foreground?.cwd, info?.cwd].find((value) => typeof value === 'string' && value !== '') ?? '';
}

// --- 画面 ---

// 画面を読む。hc read は色の無い文字で返す（実測）。空白がノーブレークスペースで来ても揃える（herdr.mjs の readScreen と同じ）。
export function readScreen(t) {
  const text = hc(['read', t])?.text;
  return typeof text === 'string' ? text.replace(/\u00a0/g, ' ') : null;
}

// 入力欄の書きかけ。色が無いので薄字のサジェストを見分けられない。orca.mjs の draftFromRead と同じく、
// 案内の形（`Try "…"`）だけを空とみなし、ほかは書きかけとして止まる側に倒す。
export function draftFromHcScreen(screen) {
  if (screen === null) return null;
  const text = draftFromScreen(screen);
  return text !== null && /^Try ".*"$/.test(text) ? '' : text;
}

export function inputDraft(t) {
  return draftFromHcScreen(readScreen(t));
}

export function backgroundWorkHint(t) {
  return backgroundHintFromScreen(readScreen(t));
}

// --- 入力 ---

// 状態を知らせたことのある端末（claude が動く端末）の中から、状態を知らせるプログラムへ送ると、hc は文を `<hc from="t8 名前">…</hc>` で包む。
// 呼び出し元の端末（HC_TERMINAL_ID）を外して送ると包まない（どちらも 0.1.21 で実測）。
// 包まれると `/exit`・`/clear`・`@<資料>` が効かないので、外して、人が打ったのと同じ形で送る。
export function rawEnv(env = process.env) {
  const copy = { ...env };
  delete copy.HC_TERMINAL_ID;
  return copy;
}

// 送る前に弾かれたと分かる kind（hc schema の terminal.send の errors）。ここに無いものは「届いたかもしれない」側に置く。
// blocked は承認・問いのダイアログで止まっている（--force を付けなければ打たない）、cancelled は打つ前に取り消された。
export const SEND_REFUSED = new Set(['not_found', 'machine_unknown', 'finished', 'blocked', 'status_mismatch', 'cancelled', 'invalid_params']);

// 貼り付けて Enter を押す。人の書きかけがあれば、最後のキーから60秒まで送るのを待つ（hc send --help）。
export function prompt(t, text) {
  return hc(['send', '--', t, text], { env: rawEnv() }) !== null;
}

// --- 端末の一覧 ---

// このマシンの端末か。ほかのマシンの端末（`aero/t5`）も hc ls に並ぶが、見張りはマシンごとに走るので、二重に知らせないよう外す。
export const isLocal = (address) => typeof address === 'string' && address !== '' && !address.includes('/');

// 見張り（watch-context.mjs）が読む形の claude の一覧。取れなければ null。
// ls には前景とラベルが載らないので、このマシンの生きた端末ごとに get で引く。
export function claudeTerminals() {
  const terminals = hc(['ls'])?.terminals;
  if (!Array.isArray(terminals)) return null;
  const infos = terminals.filter((t) => t?.state === 'live' && isLocal(t.address)).map((t) => terminalInfo(t.address));
  return claudeTerminalsFrom(infos);
}

export function claudeTerminalsFrom(infos) {
  return infos
    .filter((info) => isClaude(info))
    .map((info) => ({
      id: info.address,
      name: info.name ?? '',
      label: info.name || info.title || info.address,
      sid: sessionIdOf(info),
      cwd: cwdOf(info),
      status: statusOf(info),
    }));
}

// --- 名前 ---

// hc の名前の規則（hc run --help: 1-32 of a-z 0-9 - _）。
export const NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

// 名前を規則に合う形にする。合う字が残らなければ ''。
export function slugName(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

// 生きた端末が握っている名前。取れなければ null（呼び出し側は「空き」と混ぜないこと）。
export function liveNames() {
  const terminals = hc(['ls'])?.terminals;
  if (!Array.isArray(terminals)) return null;
  return new Set(terminals.filter((t) => t?.state === 'live' && isLocal(t.address) && t.name).map((t) => t.name));
}

// 立て直す先の名前。hc は名前を付け替えられず、名前は生きた端末の間で一意なので、旧の端末が生きている間は同じ名前を使えない。
// 空いていればそのまま、旧が握っていれば `-2` を付ける（`-2` で終わる名前なら外す）。立て直すたびに2つの名前を行き来し、どちらも読める。
export function successorName(name, taken) {
  if (!name || !taken.has(name)) return name;
  if (/-2$/.test(name)) return name.slice(0, -2);
  return `${name.slice(0, 30).replace(/-+$/, '')}-2`;
}

// --- claude の起動 ---

// 新しい端末で claude を起動し、最初の依頼を引数で渡す（claude は引数の文を最初の入力として送る）。
// 起動したばかりの claude へ hc send で送ると落ちることがあると hc の文書にあるので、送らずに引数で渡す。
// --no-parent は外さない。呼び出し元の端末の子にすると、呼び出し元が終わったときに一緒に終わる（hc の既定。実測）。
// 返すのは address。作れなければ ''（理由は hcError()）。
export function startClaude({ cwd, name, request }) {
  const created = hc(['run', '--bg', '--no-parent', '--cwd', cwd, ...(name ? ['--name', name] : []), '--', 'claude', request]);
  return created?.address ?? '';
}

const slot = new Int32Array(new SharedArrayBuffer(4));
export function sleep(seconds) {
  Atomics.wait(slot, 0, 0, seconds * 1000);
}

// 起動した claude が依頼を受け取って動き出したか（startedOf は1回分の見方、waitForStart が待つ）。返すのは次のどれか。
// - { result: 'started' }: working か done になった、またはターンが進んだ（短いターンは見る前に終わる）。
// - { result: 'blocked' }: 起動の時のダイアログ（フォルダーの信頼など）で止まっている。答えれば依頼の文を読み始める。
// - { result: 'exited', info }: claude が終わって端末が閉じた。
// - { result: 'unknown' }: 時間内にどれにもならなかった。
export function startedOf(info) {
  if (!info) return null;
  if (info.state === 'finished') return 'exited';
  const status = statusOf(info);
  if (status === 'working' || status === 'done' || (Number.isInteger(info.turn) && info.turn > 0)) return 'started';
  if (status === 'blocked') return 'blocked';
  return null;
}

// blocked は見た時点で返す。ダイアログは人が答えるまで続き、待っても変わらない（新セッションが読んだ後に出した問いでも、見てもらうのは同じ）。
export function waitForStart(t, seconds = 60) {
  for (let i = 0; i < seconds; i += 1) {
    sleep(1);
    const info = terminalInfo(t);
    const seen = startedOf(info);
    if (seen !== null) return { result: seen, info };
  }
  return { result: 'unknown' };
}

// 端末を閉じる。終わっていなければ止めてから、一覧から外す。
export function closeTerminal(t) {
  const info = terminalInfo(t);
  if (info?.state === 'live' && hc(['kill', t]) === null) return false;
  return hc(['rm', t]) !== null;
}
