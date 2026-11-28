#!/usr/bin/env node
// 同じマシンのエージェントのセッションどうしで、資源（キーボードとマウス・CPU など）の鍵を取り合う。
// 鍵は資源ごとに1つのファイルで、持ち主は1つ。持ち主が外さずに落ちても、見込みの時刻（until）を過ぎるか、
// 持ち主の Claude Code のプロセスが無くなれば、外れたとみなす。
// 何を止めるか・了承を取るか・知らせるかは資源ごとの方針で、ここでは持たない（input-takeover・heavy-task の skill）。
//
// 使い方（JSON を1行出す）:
//   node locks.cjs status  <資源>
//   node locks.cjs acquire <資源> --what <何をするか> (--minutes <分> | --ms <ミリ秒>) [--same-root]
//   node locks.cjs release <資源> [--same-root]
//   node locks.cjs clear   <資源> [--holder <セッション> --until <時刻>]（効いていない鍵を消す）
//   node locks.cjs claim   <資源> --key <札> [--keep-ms <ミリ秒>]（同じ知らせを1つのセッションだけが出すための札を取る）
// 共通: --session <自分を見分ける文字列>（無ければ CLAUDE_CODE_SESSION_ID）・--root <作業フォルダ>（無ければ今のフォルダ）・
//       --now <Unix ミリ秒>（無ければ今。呼ぶ側の時計に合わせるとき）・--home <ホーム>（試すとき）
// 終了コード: 0 は答えを出したとき（取れなかったときも 0 で、ok: false）。1 は鍵を扱えなかったとき。2 は引数の誤り。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ファイルを読み書きする間の取り合いは、取り合いのファイルを排他で作れるか（O_EXCL。どの OS でも、あれば失敗する）で決める。
// ファイルには、入ったプロセスの pid と入った時刻と、その回だけの札を書く。持ち主のプロセスが無くなったか、
// STALE_MUTEX_MS より前に入ったまま残っているものを消し、消す直前と出るときに札を読み直して、ほかのプロセスが作り直したものを消さない。
// 中で鍵のファイルを読み書きするのは数ミリ秒なので、遅いだけの持ち主を消すことは無い。
// ADR: 持ち主がその数ミリ秒の間に落ち、2つの待ち手が札を読み直してから消すまでの間に入れ違うと、2つが同時に入りうる。
// 通常の使い方では起きないので、それを閉じるための手順（二重の取り合いなど）は足さない。
const MUTEX_WAIT_MS = 3000;
const MUTEX_RETRY_MS = 20;
// pid が使い回されて生きて見えても、これより前に入ったものは残りとみなす。
const STALE_MUTEX_MS = 60 * 1000;
// 作ってから札を書くまでの間に持ち主が落ちると、中身の無いファイルが残る。待ち手が諦める前に消せるよう、MUTEX_WAIT_MS より短くする。
const EMPTY_MUTEX_MS = 2 * 1000;

// FIX: 前の置き場（input-takeover の mod が rule-guards にあった頃）の鍵。切り替えの瞬間に置かれていた鍵を守るため、効いている間は見る。
// 置き場をそろえた後、前の作りで置かれた鍵がもう残っていないので、読むのをやめてよい。
const LEGACY = { input: 'input-takeover.json' };

const RESOURCE = /^[a-z][a-z0-9-]*$/;

function homeOf(options) {
  return options.home ?? os.homedir();
}

function lockDir(options) {
  return path.join(homeOf(options), '.claude', 'locks');
}

function lockPath(resource, options) {
  return path.join(lockDir(options), `${resource}.json`);
}

const isLock = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.session === 'string' &&
  typeof value.root === 'string' &&
  typeof value.what === 'string' &&
  typeof value.until === 'number';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// 置かれた鍵を返す。時刻を過ぎていても、持ち主が落ちていても返す。無い・壊れているときは undefined。
function readRaw(resource, options = {}) {
  const lock = readJson(lockPath(resource, options));
  return isLock(lock) ? lock : undefined;
}

function readLegacy(resource, options) {
  const name = LEGACY[resource];
  if (name === undefined) return undefined;
  const lock = readJson(path.join(homeOf(options), '.claude', name));
  return isLock(lock) ? { resource, since: lock.until, ...lock, legacy: true } : undefined;
}

function sessionsDir(options) {
  return path.join(homeOf(options), '.claude', 'sessions');
}

// Claude Code が動いているセッションごとに置く ~/.claude/sessions/<pid>.json から、セッションのプロセスを引く。
// FIX: 公開された API ではないので、版によって読めなくなりうる。読めなければ pid を持たず、見込みの時刻だけで決める。
function claudePidOf(session, options) {
  const dir = sessionsDir(options);
  const hinted = Number(process.env.CLAUDE_PID);
  const candidates = Number.isInteger(hinted) && hinted > 0 ? [`${hinted}.json`] : [];
  try {
    candidates.push(...fs.readdirSync(dir).filter((name) => /^\d+\.json$/.test(name)));
  } catch {
    return undefined;
  }
  for (const name of candidates) {
    const record = readJson(path.join(dir, name));
    if (record?.sessionId === session && Number.isInteger(record.pid)) return record.pid;
  }
  return undefined;
}

// 持ち主が生きているか。true・false か、分からなければ null。
// pid は、鍵を置いたときに Claude Code のセッションの記録から引けたときだけ持つ。
// プロセスが無ければ落ちた。プロセスがあっても、その pid の記録が別のセッションを指していれば、pid が使い回されたか、
// 同じプロセスで別のセッション（/clear の後など）に移ったので、持ち主はもういない。
// 記録が無い・読めないときは決めない（書き直しの途中かもしれず、生きている持ち主の鍵を外すと、入力を奪い合うため）。
function holderAlive(lock, options = {}) {
  if (!Number.isInteger(lock.pid)) return null;
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
  }
  const record = readJson(path.join(sessionsDir(options), `${lock.pid}.json`));
  if (typeof record?.sessionId !== 'string') return null;
  return record.sessionId === lock.session;
}

const isOwn = (lock, { session, root, sameRoot }) => lock.session === session || (sameRoot === true && root !== undefined && lock.root === root);

// 置かれた鍵の状態。lock は効いている鍵（無ければ null）。last は置かれたままの鍵（切れたもの・持ち主が落ちたものも）。
// state: free（置かれていない）・held・expired（見込みの時刻を過ぎた）・dead（持ち主が落ちた）。
// alive は last の持ち主が生きているか（分からなければ null）。切れた後に持ち主が落ちたかを、呼ぶ側が知らせるため。
function status(resource, options) {
  const now = options.now ?? Date.now();
  const opts = { ...options, now };
  const raw = readRaw(resource, opts);
  const alive = raw === undefined ? null : holderAlive(raw, opts);
  const state = raw === undefined ? 'free' : raw.until <= now ? 'expired' : alive === false ? 'dead' : 'held';
  if (state === 'held') return { state, lock: raw, last: raw, alive };
  const legacy = readLegacy(resource, opts);
  if (legacy !== undefined && legacy.until > now) return { state: 'held', lock: legacy, last: legacy, alive: null };
  return { state, lock: null, last: raw ?? null, alive };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

// 持ち主が落ちて残った取り合いのファイルを消す。消す直前に札を読み直し、見たときと同じときだけ消す。
function breakDeadMutex(mutex) {
  const token = readText(mutex);
  if (token === undefined) return;
  if (token === '') {
    try {
      if (Date.now() - fs.statSync(mutex).mtimeMs <= EMPTY_MUTEX_MS) return;
    } catch {
      return;
    }
  } else {
    const [pid, since] = token.split(':').map(Number);
    if (pidAlive(pid) && Number.isFinite(since) && Date.now() - since <= STALE_MUTEX_MS) return;
  }
  if (readText(mutex) === token) fs.rmSync(mutex, { force: true });
}

function withMutex(resource, options, fn) {
  fs.mkdirSync(lockDir(options), { recursive: true });
  const mutex = `${lockPath(resource, options)}.mutex`;
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + MUTEX_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(mutex, token, { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      breakDeadMutex(mutex);
      if (Date.now() > deadline) throw new Error(`${resource} の鍵のファイルを扱えなかった（${mutex} をほかのプロセスが持ったまま）`);
      sleepSync(MUTEX_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    // 自分の札のときだけ消す。
    if (readText(mutex) === token) fs.rmSync(mutex, { force: true });
  }
}

// 隣に書いてから置き換える。書く途中で読まれても壊れて見えないように。
// FIX: Windows では、ほかのプロセスが読んでいる間の置き換えが EPERM・EBUSY で失敗することがあるので、少し待って置き直す。
function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      if (attempt >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        fs.rmSync(temp, { force: true });
        throw error;
      }
      sleepSync(MUTEX_RETRY_MS);
    }
  }
}

function writeLock(resource, lock, options) {
  writeAtomic(lockPath(resource, options), JSON.stringify(lock));
}

// 鍵を置く。ほかのセッションの鍵が効いていれば置かず、その鍵を返す。自分の鍵なら置き直して延ばす。
// sameRoot は、同じ作業フォルダのセッションの鍵も自分のもの（立ち上がり直す前の自分）とみなすか。
// previous は、置く前に置かれていた鍵（切れたもの・持ち主が落ちたものも）。呼ぶ側が、終わりを知らせてから上書きしたことを知るため。
function acquire(resource, options) {
  const { session, root, what, ms } = options;
  const now = options.now ?? Date.now();
  const opts = { ...options, now };
  return withMutex(resource, opts, () => {
    const { lock: held, last } = status(resource, opts);
    if (held !== null && (!isOwn(held, opts) || (held.session !== session && holderAlive(held, opts) === true))) return { ok: false, heldBy: held };
    // 引けなければ、同じセッションの前の鍵の pid を引き継ぐ（延ばしたときに、落ちたかを見られなくならないように）。
    const pid = claudePidOf(session, opts) ?? (held?.session === session ? held.pid : undefined);
    const lock = { resource, session, root, what, since: held !== null && held.session === session && !held.legacy ? held.since : now, until: now + ms };
    if (pid !== undefined) lock.pid = pid;
    writeLock(resource, lock, opts);
    if (held?.legacy) releaseLegacy(resource, opts);
    return { ok: true, lock, previous: last };
  });
}

function releaseLegacy(resource, options) {
  const legacy = readLegacy(resource, options);
  if (legacy !== undefined && isOwn(legacy, options)) fs.writeFileSync(path.join(homeOf(options), '.claude', LEGACY[resource]), '{}');
}

// 自分の鍵を外す。外した鍵を返す（無ければ null）。見込みの時刻を過ぎた自分の鍵も外して返す（呼ぶ側が、終わったことを知らせるため）。
// sameRoot でも、同じフォルダのほかのセッションの鍵は、その持ち主が生きていると分かれば外さない（立ち上がり直す前の自分でなく、
// 同じフォルダで動くほかのセッションの、操作の途中の鍵なので）。置き直しての引き継ぎ（acquire）は、了承を取り直す呼ぶ側に任せる。
const releasable = (lock, options) => lock.session === options.session || (isOwn(lock, options) && holderAlive(lock, options) !== true);

function release(resource, options) {
  const now = options.now ?? Date.now();
  const opts = { ...options, now };
  return withMutex(resource, opts, () => {
    const raw = readRaw(resource, opts);
    if (raw === undefined) {
      const legacy = readLegacy(resource, opts);
      if (legacy === undefined || !isOwn(legacy, opts)) return { released: null };
      releaseLegacy(resource, opts);
      return { released: legacy };
    }
    if (!releasable(raw, opts)) return { released: null };
    fs.rmSync(lockPath(resource, opts), { force: true });
    return { released: raw };
  });
}

// 効いていない鍵（見込みの時刻を過ぎたもの・持ち主が落ちたもの）を消す。消した鍵を返す（無ければ null）。
// 持ち主でなくても消せる。誰も使っていない鍵なので。見張る側が、終わりを知らせた後に片付け、読み続けずに済むようにするため。
// holder・until を渡すと、その鍵のときだけ消す（知らせた後に別の鍵へ置き換わっていたら、知らせていない鍵を消さないため）。
function clear(resource, options) {
  const now = options.now ?? Date.now();
  const opts = { ...options, now };
  return withMutex(resource, opts, () => {
    const { state, last } = status(resource, opts);
    if ((state !== 'expired' && state !== 'dead') || last === null || last.legacy) return { cleared: null };
    if ((options.holder !== undefined && last.session !== options.holder) || (options.until !== undefined && last.until !== options.until)) return { cleared: null };
    fs.rmSync(lockPath(resource, opts), { force: true });
    return { cleared: last };
  });
}

// 同じ知らせを、同じマシンのセッションのうち1つだけが出すための札。key を初めて取ったときだけ claimed: true。
// 取った札は keepMs のあいだ覚え、それより古いものは書くときに落とす。
function claimsPath(resource, options) {
  return path.join(lockDir(options), `${resource}.claims.json`);
}

function claim(resource, options) {
  const now = options.now ?? Date.now();
  const opts = { ...options, now };
  return withMutex(resource, opts, () => {
    const file = claimsPath(resource, opts);
    const current = readJson(file);
    const claims = current !== null && typeof current === 'object' && !Array.isArray(current) ? current : {};
    const kept = Object.fromEntries(Object.entries(claims).filter(([, c]) => typeof c?.at === 'number' && now - c.at < options.keepMs));
    if (kept[options.key] !== undefined) return { claimed: false, by: kept[options.key].by };
    kept[options.key] = { by: options.session, at: now };
    writeAtomic(file, JSON.stringify(kept));
    return { claimed: true };
  });
}

function parseArgs(argv) {
  const [command, resource, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i];
    const value = () => {
      const next = rest[++i];
      if (next === undefined) throw new Error(`${name} に値が要る`);
      return next;
    };
    if (name === '--session') options.session = value();
    else if (name === '--root') options.root = value();
    else if (name === '--what') options.what = value();
    else if (name === '--home') options.home = value();
    else if (name === '--same-root') options.sameRoot = true;
    else if (name === '--now') options.now = Number(value());
    else if (name === '--ms') options.ms = Number(value());
    else if (name === '--minutes') options.ms = Number(value()) * 60 * 1000;
    else if (name === '--key') options.key = value();
    else if (name === '--keep-ms') options.keepMs = Number(value());
    else if (name === '--holder') options.holder = value();
    else if (name === '--until') options.until = Number(value());
    else throw new Error(`知らない引数: ${name}`);
  }
  if (!['status', 'acquire', 'release', 'clear', 'claim'].includes(command)) throw new Error('status・acquire・release・clear・claim のどれかを書く');
  if (!RESOURCE.test(resource ?? '')) throw new Error('資源の名前（英小文字・数字・-）を書く');
  options.session ??= process.env.CLAUDE_CODE_SESSION_ID;
  options.root ??= process.cwd();
  if (options.now !== undefined && !Number.isFinite(options.now)) throw new Error('--now は数で書く');
  if (command === 'claim') {
    if (!options.key) throw new Error('--key が要る');
    options.keepMs ??= 10 * 60 * 1000;
    if (!(Number.isFinite(options.keepMs) && options.keepMs > 0)) throw new Error('--keep-ms は正の数で書く');
  }
  if ((command === 'acquire' || command === 'release' || command === 'claim') && !options.session) throw new Error('--session が要る（CLAUDE_CODE_SESSION_ID も無い）');
  if (command === 'acquire') {
    if (!options.what) throw new Error('--what が要る');
    if (!(Number.isFinite(options.ms) && options.ms > 0 && Number.isFinite((options.now ?? Date.now()) + options.ms))) throw new Error('--minutes か --ms に正の数が要る');
  }
  return { command, resource, options };
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  const { command, resource, options } = parsed;
  try {
    const result = { status, acquire, release, clear, claim }[command](resource, options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
} else {
  module.exports = { acquire, release, clear, claim, status, readRaw, holderAlive, lockPath, lockDir };
}
