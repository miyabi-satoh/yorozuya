// node --test scripts/locks.test.cjs
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const locks = require('./locks.cjs');

const CLI = path.join(__dirname, 'locks.cjs');

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locks-'));
  fs.mkdirSync(path.join(dir, '.claude', 'sessions'), { recursive: true });
  return dir;
}

// Claude Code のセッションの記録を置く。pid のプロセスが生きていれば、持ち主は生きているとみなされる。
function session(dir, pid, sessionId) {
  fs.writeFileSync(path.join(dir, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId }));
}

const base = (dir, extra = {}) => ({ home: dir, root: '/p/a', what: 'e2e', ms: 60_000, now: 1000, ...extra });

test('置かれていなければ free', () => {
  const dir = home();
  assert.deepEqual(locks.status('input', { home: dir, now: 0 }), { state: 'free', lock: null, last: null, alive: null });
});

test('ほかのセッションの鍵が効いていれば取れず、自分は延ばせる', () => {
  const dir = home();
  const first = locks.acquire('input', base(dir, { session: 'a' }));
  assert.equal(first.ok, true);
  assert.equal(first.lock.until, 61_000);
  const other = locks.acquire('input', base(dir, { session: 'b', root: '/p/b', now: 2000 }));
  assert.equal(other.ok, false);
  assert.equal(other.heldBy.session, 'a');
  const again = locks.acquire('input', base(dir, { session: 'a', now: 30_000 }));
  assert.equal(again.ok, true);
  assert.equal(again.lock.since, 1000, '延ばしても始めた時刻は変えない');
  assert.equal(again.lock.until, 90_000);
});

test('同じフォルダの鍵は、sameRoot のときだけ自分のものとして引き継ぐ', () => {
  const dir = home();
  locks.acquire('input', base(dir, { session: 'old' }));
  assert.equal(locks.acquire('cpu', base(dir, { session: 'x' })).ok, true);
  assert.equal(locks.acquire('cpu', base(dir, { session: 'y' })).ok, false, 'cpu は同じフォルダでも別のセッション');
  assert.equal(locks.acquire('input', base(dir, { session: 'new' })).ok, false);
  const taken = locks.acquire('input', base(dir, { session: 'new', sameRoot: true }));
  assert.equal(taken.ok, true);
  assert.equal(taken.lock.since, 1000, '引き継ぎは始め直し');
  assert.equal(taken.previous.session, 'old');
});

test('見込みの時刻を過ぎた鍵は expired で、ほかのセッションが取れる', () => {
  const dir = home();
  locks.acquire('input', base(dir, { session: 'a' }));
  const later = locks.status('input', { home: dir, now: 61_000 });
  assert.equal(later.state, 'expired');
  assert.equal(later.lock, null);
  assert.equal(later.last.session, 'a');
  const taken = locks.acquire('input', base(dir, { session: 'b', now: 61_000 }));
  assert.equal(taken.ok, true);
  assert.equal(taken.previous.session, 'a', '上書きした切れた鍵を返す');
});

test('持ち主の Claude Code が落ちていれば dead で、ほかのセッションが取れる', async () => {
  const dir = home();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  session(dir, child.pid, 'a');
  const placed = locks.acquire('input', base(dir, { session: 'a', ms: 10 * 60_000 }));
  assert.equal(placed.lock.pid, child.pid);
  assert.equal(locks.status('input', { home: dir, now: 2000 }).state, 'held');
  child.kill();
  await new Promise((resolve) => child.on('exit', resolve));
  const after = locks.status('input', { home: dir, now: 2000 });
  assert.equal(after.state, 'dead');
  assert.equal(after.alive, false);
  assert.equal(locks.status('input', { home: dir, now: 999_999 }).alive, false, '切れた後でも、落ちたかが分かる');
  assert.equal(after.last.session, 'a');
  assert.equal(locks.acquire('input', base(dir, { session: 'b', root: '/p/b', now: 2000 })).ok, true);
});

test('pid が別のセッションに使い回されていれば dead、記録が読めなければ見込みの時刻だけで決める', () => {
  const dir = home();
  session(dir, process.pid, 'a');
  locks.acquire('input', base(dir, { session: 'a' }));
  session(dir, process.pid, 'other');
  assert.equal(locks.status('input', { home: dir, now: 2000 }).state, 'dead');
  fs.rmSync(path.join(dir, '.claude', 'sessions', `${process.pid}.json`));
  const unknown = locks.status('input', { home: dir, now: 2000 });
  assert.equal(unknown.state, 'held', 'プロセスが生きていて記録が無いときは、外さない');
  assert.equal(unknown.alive, null);

  const bare = home();
  fs.rmSync(path.join(bare, '.claude', 'sessions'), { recursive: true });
  const placed = locks.acquire('input', base(bare, { session: 'a' }));
  assert.equal(placed.lock.pid, undefined);
  assert.equal(locks.status('input', { home: bare, now: 2000 }).state, 'held');
});

test('自分の鍵だけを外し、切れた自分の鍵も外して返す', () => {
  const dir = home();
  locks.acquire('input', base(dir, { session: 'a' }));
  assert.deepEqual(locks.release('input', { home: dir, session: 'b', now: 2000 }), { released: null });
  assert.equal(locks.release('input', { home: dir, session: 'a', now: 999_999 }).released.session, 'a');
  assert.equal(locks.status('input', { home: dir, now: 0 }).state, 'free');
  assert.deepEqual(locks.release('input', { home: dir, session: 'a', now: 0 }), { released: null });
});

test('同時に取りに来ても、取れるのは1つだけ', async () => {
  const dir = home();
  const runs = Array.from({ length: 8 }, (_, i) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'acquire', 'cpu', '--home', dir, '--session', `s${i}`, '--root', `/p/${i}`, '--what', 'build', '--ms', '60000']);
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.on('exit', (code) => resolve({ code, out }));
    }),
  );
  const results = await Promise.all(runs);
  assert.ok(results.every((r) => r.code === 0));
  assert.equal(results.filter((r) => JSON.parse(r.out).ok).length, 1);
});

// 終わったプロセスの pid を得る。
function deadPid() {
  return spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
}

test('持ち主のプロセスが無くなって残った取り合いのファイルは、消して進む', () => {
  const dir = home();
  const mutex = `${locks.lockPath('cpu', { home: dir })}.mutex`;
  fs.mkdirSync(path.dirname(mutex), { recursive: true });
  fs.writeFileSync(mutex, `${deadPid()}:0:x`);
  assert.equal(locks.acquire('cpu', base(dir, { session: 'a' })).ok, true);
  assert.equal(fs.existsSync(mutex), false, '出るときに自分の札を消す');
});

test('生きている持ち主が入ったばかりの取り合いのファイルは消さず、待って諦める', () => {
  const dir = home();
  const mutex = `${locks.lockPath('cpu', { home: dir })}.mutex`;
  fs.mkdirSync(path.dirname(mutex), { recursive: true });
  const token = `${process.pid}:${Date.now()}:x`;
  fs.writeFileSync(mutex, token);
  assert.throws(() => locks.acquire('cpu', base(dir, { session: 'a' })), /cpu の鍵のファイルを扱えなかった/);
  assert.equal(fs.readFileSync(mutex, 'utf8'), token);
});

test('pid が使い回されて生きて見えても、1分より前に入ったままのものと、読めない札は消して進む', () => {
  const dir = home();
  const mutex = `${locks.lockPath('cpu', { home: dir })}.mutex`;
  fs.mkdirSync(path.dirname(mutex), { recursive: true });
  fs.writeFileSync(mutex, `${process.pid}:${Date.now() - 120_000}:x`);
  assert.equal(locks.acquire('cpu', base(dir, { session: 'a' })).ok, true);
  fs.writeFileSync(mutex, 'garbled');
  assert.equal(locks.acquire('cpu', base(dir, { session: 'a', now: 2000 })).ok, true);
});

test('CLI は JSON を出し、引数の誤りは 2 で返す', () => {
  const dir = home();
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--home', dir], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'env-session', CLAUDE_PID: '' } });
  const placed = run('acquire', 'input', '--what', 'x', '--minutes', '5', '--root', '/p/a');
  assert.equal(placed.status, 0);
  assert.equal(JSON.parse(placed.stdout).lock.session, 'env-session', 'セッションは環境変数から');
  assert.equal(JSON.parse(run('status', 'input').stdout).state, 'held');
  assert.equal(run('acquire', 'input', '--minutes', '5').status, 2);
  assert.equal(run('acquire', 'input', '--what', 'x', '--minutes', '-1').status, 2);
  assert.equal(run('lock', 'input').status, 2);
  assert.equal(run('status', '../x').status, 2);
  assert.equal(JSON.parse(run('release', 'input').stdout).released.session, 'env-session');
});

test('clear は効いていない鍵だけを、持ち主でなくても消す', () => {
  const dir = home();
  locks.acquire('input', base(dir, { session: 'a' }));
  assert.deepEqual(locks.clear('input', { home: dir, now: 2000 }), { cleared: null }, '効いている鍵は消さない');
  assert.equal(locks.clear('input', { home: dir, now: 61_000 }).cleared.session, 'a');
  assert.equal(locks.status('input', { home: dir, now: 0 }).state, 'free');
  assert.deepEqual(locks.clear('input', { home: dir, now: 0 }), { cleared: null });
});

test('延ばしたときに pid を引けなければ、前の鍵の pid を引き継ぐ', () => {
  const dir = home();
  session(dir, process.pid, 'a');
  assert.equal(locks.acquire('input', base(dir, { session: 'a' })).lock.pid, process.pid);
  fs.rmSync(path.join(dir, '.claude', 'sessions'), { recursive: true });
  assert.equal(locks.acquire('input', base(dir, { session: 'a', now: 5000 })).lock.pid, process.pid);
});

test('clear は、holder・until を渡すと、その鍵のときだけ消す', () => {
  const dir = home();
  locks.acquire('input', base(dir, { session: 'a' }));
  assert.deepEqual(locks.clear('input', { home: dir, now: 61_000, holder: 'b' }), { cleared: null });
  assert.deepEqual(locks.clear('input', { home: dir, now: 61_000, holder: 'a', until: 1 }), { cleared: null });
  assert.equal(locks.clear('input', { home: dir, now: 61_000, holder: 'a', until: 61_000 }).cleared.session, 'a');
});

test('claim は、同じ札を初めて取ったときだけ true で、古い札は落とす', async () => {
  const dir = home();
  const opts = (extra) => ({ home: dir, keepMs: 10_000, now: 0, ...extra });
  assert.deepEqual(locks.claim('input', opts({ key: 'k', session: 'a' })), { claimed: true });
  assert.deepEqual(locks.claim('input', opts({ key: 'k', session: 'b' })), { claimed: false, by: 'a' });
  assert.equal(locks.claim('input', opts({ key: 'k', session: 'b', now: 20_000 })).claimed, true, '古い札は無いものとみなす');

  const runs = Array.from({ length: 8 }, (_, i) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'claim', 'cpu', '--home', dir, '--session', `s${i}`, '--key', 'same']);
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.on('exit', () => resolve(JSON.parse(out)));
    }),
  );
  assert.equal((await Promise.all(runs)).filter((r) => r.claimed).length, 1);
});

test('sameRoot の release は、同じフォルダのほかのセッションの鍵を、その持ち主が生きていれば外さない', () => {
  const dir = home();
  session(dir, process.pid, 'other');
  locks.acquire('input', base(dir, { session: 'other' }));
  assert.deepEqual(locks.release('input', { home: dir, session: 'me', root: '/p/a', sameRoot: true, now: 2000 }), { released: null });
  // 持ち主が生きているかを確かめられなければ、立ち上がり直す前の自分の鍵として外せる。
  fs.rmSync(path.join(dir, '.claude', 'sessions', `${process.pid}.json`));
  assert.equal(locks.release('input', { home: dir, session: 'me', root: '/p/a', sameRoot: true, now: 2000 }).released.session, 'other');
});
