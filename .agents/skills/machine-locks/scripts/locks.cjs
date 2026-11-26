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
//   node locks.cjs clear   <資源>（効いていない鍵を消す）
// 共通: --session <自分を見分ける文字列>（無ければ CLAUDE_CODE_SESSION_ID）・--root <作業フォルダ>（無ければ今のフォルダ）・
//       --now <Unix ミリ秒>（無ければ今。呼ぶ側の時計に合わせるとき）・--home <ホーム>（試すとき）
// 終了コード: 0 は答えを出したとき（取れなかったときも 0 で、ok: false）。1 は鍵を扱えなかったとき。2 は引数の誤り。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ファイルを読み書きする間の取り合いは、フォルダーを作れるか（mkdir は、どの OS でもあれば失敗する）で決める。
// 持ち主が落ちて残ったものは、STALE_MUTEX_MS を過ぎたら消す（読み書きは数ミリ秒で終わる）。
const MUTEX_WAIT_MS = 3000;
const MUTEX_RETRY_MS = 20;
const STALE_MUTEX_MS = 10 * 1000;

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
// pid が使い回されて別のプロセスになっていることがあるので、そのセッションの記録が残っているかも見る（Claude Code は終わるときに消す）。
function holderAlive(lock, options = {}) {
  if (!Number.isInteger(lock.pid)) return null;
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
  }
  const record = readJson(path.join(sessionsDir(options), `${lock.pid}.json`));
  return record?.sessionId === lock.session;
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

function withMutex(resource, options, fn) {
  fs.mkdirSync(lockDir(options), { recursive: true });
  const mutex = `${lockPath(resource, options)}.mutex`;
  const deadline = Date.now() + MUTEX_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(mutex);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(mutex).mtimeMs > STALE_MUTEX_MS) fs.rmdirSync(mutex);
      } catch {
        // ほかのセッションが先に消した。
      }
      if (Date.now() > deadline) throw new Error(`${resource} の鍵のファイルを扱えなかった（${mutex} が残っている）`);
      sleepSync(MUTEX_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmdirSync(mutex);
  }
}

// 書く途中で読まれても壊れて見えないよう、隣に書いてから置き換える。
function writeLock(resource, lock, options) {
  const file = lockPath(resource, options);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(lock));
  fs.renameSync(temp, file);
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
    if (held !== null && !isOwn(held, opts)) return { ok: false, heldBy: held };
    const pid = claudePidOf(session, opts);
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
    if (!isOwn(raw, opts)) return { released: null };
    fs.rmSync(lockPath(resource, opts), { force: true });
    return { released: raw };
  });
}

// 効いていない鍵（見込みの時刻を過ぎたもの・持ち主が落ちたもの）を消す。消した鍵を返す（無ければ null）。
// 持ち主でなくても消せる。誰も使っていない鍵なので。見張る側が、終わりを知らせた後に片付け、読み続けずに済むようにするため。
function clear(resource, options) {
  const now = options.now ?? Date.now();
  const opts = { ...options, now };
  return withMutex(resource, opts, () => {
    const { state, last } = status(resource, opts);
    if ((state !== 'expired' && state !== 'dead') || last === null || last.legacy) return { cleared: null };
    fs.rmSync(lockPath(resource, opts), { force: true });
    return { cleared: last };
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
    else throw new Error(`知らない引数: ${name}`);
  }
  if (!['status', 'acquire', 'release', 'clear'].includes(command)) throw new Error('status・acquire・release・clear のどれかを書く');
  if (!RESOURCE.test(resource ?? '')) throw new Error('資源の名前（英小文字・数字・-）を書く');
  options.session ??= process.env.CLAUDE_CODE_SESSION_ID;
  options.root ??= process.cwd();
  if (options.now !== undefined && !Number.isFinite(options.now)) throw new Error('--now は数で書く');
  if ((command === 'acquire' || command === 'release') && !options.session) throw new Error('--session が要る（CLAUDE_CODE_SESSION_ID も無い）');
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
    const result = { status, acquire, release, clear }[command](resource, options);
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
  module.exports = { acquire, release, clear, status, readRaw, holderAlive, lockPath, lockDir };
}
