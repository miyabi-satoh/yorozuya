// herdr-core（hc）の CLI を叩く。herdr.mjs と同じく、失敗は null で返し、判断は呼び出し側に残す。
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

// core が応えないときに、見張りや再起動が止まり続けないよう打ち切る。ふだんは1回が数十ミリ秒（実測）。
// send は人の書きかけがあると最後のキーから60秒まで待つ（hc send --help）ので、その分を足す。
const TIMEOUT_MS = 15_000;
const NO_PAYLOAD = new Set(['kill', 'rm', 'send', 'keys', 'label']);
const SEND_TIMEOUT_MS = 90_000;

// hc に渡す環境。core が動いていなければ hc は呼ばれたその場で core を起動し、core はその環境を、以後に作るどの端末にも引き継ぐ。
// claude や Herdr の中から起動すると CLAUDE*・HERDR_* が全部の端末に入り、そこで起動した claude は会話の記録を書かない（実測）ので外す。
export function hcEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(CLAUDE|HERDR_)/.test(key)));
}

// 成功なら出力の JSON、失敗なら null。--json はサブコマンドの直後に置く（引数の後ろに置くと、`--` の後の文として渡ってしまう）。
// 0.1.21 ではどのサブコマンドも JSON を出す（実測）。中身の要らないもの（NO_PAYLOAD）は、終了コードが 0 なら出力が空や JSON でなくても
// 操作は通っているので成功にする。中身の要るもの（run・get・ls・read など）は、読めなければ失敗にする（空の結果を「無い」と読み違えないため）。
export function hc(args, { env, timeout } = {}) {
  const run = spawnSync('hc', [args[0], '--json', ...args.slice(1)], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    // Windows では、コンソールを持たない親（idle-clear-self.mjs が detached で起こす --send の子）から呼ぶと、hc ごとにコンソールの窓が開くため。
    windowsHide: true,
    env: env ?? hcEnv(),
    timeout: timeout ?? (args[0] === 'send' ? SEND_TIMEOUT_MS : TIMEOUT_MS),
  });
  lastKind = '';
  if (run.error) {
    lastError = String(run.error.message ?? run.error);
    return null;
  }
  if (run.status === 0) {
    try {
      const data = JSON.parse(run.stdout) ?? {};
      lastError = '';
      return data;
    } catch {
      if (NO_PAYLOAD.has(args[0])) {
        lastError = '';
        return {};
      }
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
// 名前が claude か、`node …/claude …`（npm で入れた版）なら claude と見る。
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

// 入力欄の書きかけ。色が無いので薄字のサジェストを見分けられない。
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
  const copy = hcEnv(env);
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
// 行き来する先もほかの端末が握っていれば、-3 から -9 までの空いたものにする。どれも空いていなければ ''（名前を付けずに起動する）。
// 外す後ろの数は自分で付ける -2〜-9 だけ（もとの名前の `-4b` などは外さない）。
export function successorName(name, taken) {
  if (!name || !taken.has(name)) return name;
  const base = name.replace(/-[2-9]$/, '');
  const suffixed = (n) => `${base.slice(0, 30).replace(/-+$/, '')}-${n}`;
  const candidates = base === name ? [2, 3, 4, 5, 6, 7, 8, 9].map(suffixed) : [base, ...[2, 3, 4, 5, 6, 7, 8, 9].map(suffixed)];
  return candidates.find((candidate) => candidate !== name && !taken.has(candidate)) ?? '';
}

// --- claude の起動 ---

// 新しい端末で claude を起動し、最初の依頼を引数で渡す（claude は引数の文を最初の入力として送る）。
// 起動したばかりの claude へ hc send で送ると落ちることがあると hc の文書にあるので、送らずに引数で渡す。
// --no-parent は外さない。呼び出し元の端末の子にすると、呼び出し元が終わったときに一緒に終わる（hc の既定。実測）。
// replaces は立て直す前の端末の address。ラベル replaces=<address> を付け、rencon がその端末のタイルを新しい端末へ移す目印にする（rencon は旧の端末が終わるか外れてから移す）。
// 返すのは address。作れなければ ''（理由は hcError()）。
export function startClaude({ cwd, name, request, replaces }) {
  const created = hc(['run', '--bg', '--no-parent', '--cwd', cwd, ...(name ? ['--name', name] : []), ...(replaces ? ['--label', `replaces=${replaces}`] : []), '--', 'claude', request]);
  return created?.address ?? '';
}

const slot = new Int32Array(new SharedArrayBuffer(4));
export function sleep(seconds) {
  Atomics.wait(slot, 0, 0, seconds * 1000);
}

// 起動した claude が依頼を受け取って動き出したか（startedOf は1回分の見方、waitForStart が待つ）。返すのは次のどれか。
// - { result: 'started' }: working になった、またはターンが進んだ（短いターンは見る前に終わる）。
// - { result: 'blocked' }: 起動の時のダイアログ（フォルダーの信頼など）で止まっている。答えれば依頼の文を読み始める。
// - { result: 'exited', info }: claude が終わって端末が閉じた。
// - { result: 'unknown' }: 時間内にどれにもならなかった。
// done だけでは数えない。起動したばかりの claude が、依頼を受け取る前に idle や done を知らせることがありうるため。
// 短いターンを見落としても、ターンは working を抜けるたびに進む（hc schema の turn）ので、turn で拾える。
export function startedOf(info) {
  if (!info) return null;
  if (info.state === 'finished') return 'exited';
  const status = statusOf(info);
  if (status === 'working' || (Number.isInteger(info.turn) && info.turn > 0)) return 'started';
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

// 端末を閉じる。kill は終わるまで待って結果を返す（実測）が、kill が失敗しても rm は試す（既に終わっていれば rm だけで済む）。
// rm は生きた端末を断る（kind live）ので、まだ生きていれば数秒待ってから外す。
export function closeTerminal(t) {
  hc(['kill', t]);
  for (let i = 0; i < 10 && terminalInfo(t)?.state === 'live'; i += 1) sleep(1);
  return hc(['rm', t]) !== null;
}
