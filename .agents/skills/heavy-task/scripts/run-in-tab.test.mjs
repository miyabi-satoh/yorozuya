// node --test scripts/run-in-tab.test.mjs
// hc・herdr は、タブの動きだけを真似た偽物を PATH の先頭に置いて試す。
// どの偽物でも HC_TERMINAL_ID を外す（hc の端末の中で試しても、hc を一番先に見る判定に入らないため）。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { shellFor } from './shell-choice.mjs';

const script = fileURLToPath(new URL('./run-in-tab.mjs', import.meta.url));
const fakeTools = fileURLToPath(new URL('./run-in-tab.fake-tools.cjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'run-in-tab-test-'));
const windows = process.platform === 'win32';
// POSIX のシグナルを送る・受けるテスト。Windows の Node は SIGHUP などを送ると相手をすぐ終わらせ、受けた側のハンドラーは動かない
// （Windows でタブが閉じたときの扱いは run-in-tab.mjs の STATUS_CONTROL_C_EXIT で、ここでは試せない）。
const posixSignals = { skip: windows && 'Windows には POSIX のシグナルが無い' };
// Windows でも Git Bash があれば Bash の構文で試す。
const usesPowerShell = windows && shellFor('', process.platform, process.env, fs.existsSync)[0] === 'pwsh';
const shellCommand = (posix, pwsh) => (usesPowerShell ? pwsh : posix);

// 偽物の hc・herdr を置いた bin と、偽物が書き残す state。中身は run-in-tab.fake-tools.cjs。
function fakeBin(tool) {
  const bin = tmp();
  const state = tmp();
  const link = path.join(bin, windows ? `${tool}.exe` : tool);
  try {
    fs.linkSync(process.execPath, link);
  } catch {
    // 別のドライブなどで張れなければ写す。
    fs.copyFileSync(process.execPath, link);
    fs.chmodSync(link, 0o755);
  }
  const preload = `--require ${JSON.stringify(fakeTools)}`;
  const env = {
    ...process.env,
    FAKE_TOOLS_STATE: state,
    FAKE_TOOLS_NODE: process.execPath,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    SHELL: '/bin/sh',
  };
  return { env, state };
}

function fakeHerdr() {
  const { env, state } = fakeBin('herdr');
  return { env: { ...env, HC_TERMINAL_ID: '', HERDR_ENV: '1' }, state };
}

// 名前の taken-<名前> を state に置くと、その名前を name_taken で断る。
function fakeHc() {
  const { env, state } = fakeBin('hc');
  // HERDR_ENV=1 も入れておく。hc の端末は core を起動した環境の HERDR_ENV を引き継ぐことがあり、それでも hc を先にする。
  const calls = () => fs.readFileSync(path.join(state, 'calls'), 'utf8').trim().split('\n');
  return { env: { ...env, HC_TERMINAL_ID: 't3', HERDR_ENV: '1' }, state, calls };
}

function run(env, ...args) {
  return spawnSync('node', [script, ...args], { encoding: 'utf8', env });
}

test('出力と終了コードを残し、終わったらタブを閉じる', () => {
  const { env, state } = fakeHerdr();
  const dir = tmp();
  const result = run(env, '--dir', dir, '--', shellCommand('echo out; echo err >&2; exit 3', "echo out; [Console]::Error.WriteLine('err'); exit 3"));
  assert.equal(result.status, 3);
  assert.match(result.stdout, /exit=3/);
  const log = fs.readFileSync(path.join(dir, 'output.log'), 'utf8');
  assert.match(log, /\$ echo out/);
  assert.match(log, /^out$/m);
  assert.match(log, /^err$/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'exit.json'), 'utf8')).code, 3);
  assert.equal(fs.existsSync(path.join(state, 'closed')), true);
});

test('シグナルで落ちた処理は、シグナルの名前を残す', posixSignals, () => {
  const { env } = fakeHerdr();
  const dir = tmp();
  const result = run(env, '--dir', dir, '--', 'kill -KILL $$');
  assert.equal(result.status, 137);
  assert.match(result.stdout, /signal=SIGKILL/);
});

test('タブの側が止められたら、受けたシグナルを残す', posixSignals, async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ command: 'sleep 30', cwd: dir }));
  const child = spawn('node', [script, '--runner', dir], { stdio: 'ignore', env: { ...process.env, SHELL: '/bin/sh' } });
  while (!fs.existsSync(path.join(dir, 'output.log'))) await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise((resolve) => setTimeout(resolve, 200));
  child.kill('SIGHUP');
  await new Promise((resolve) => child.on('exit', resolve));
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'exit.json'), 'utf8'));
  assert.equal(result.interruptedBy, 'SIGHUP');
  assert.equal(result.signal, 'SIGHUP');
});

test('止める知らせを無視する処理でも、理由を残して終わる', posixSignals, async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ command: "trap '' HUP; sleep 30 & echo $! > pid; wait", cwd: dir }));
  const child = spawn('node', [script, '--runner', dir], { stdio: 'ignore', env: { ...process.env, SHELL: '/bin/sh' } });
  while (!fs.existsSync(path.join(dir, 'pid')) || !fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim()) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGHUP');
  await new Promise((resolve) => child.on('exit', resolve));
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'exit.json'), 'utf8'));
  assert.equal(result.interruptedBy, 'SIGHUP');
  assert.equal(result.signal, 'SIGKILL');
  const grandchild = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
  assert.throws(() => process.kill(grandchild, 0), { code: 'ESRCH' });
});

test('待ち直すと、終わった処理の結果を読める', () => {
  const { env } = fakeHerdr();
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ pane: 'w1:p1', tab: 'w1:t1' }));
  fs.writeFileSync(path.join(dir, 'output.log'), 'done\n');
  fs.writeFileSync(path.join(dir, 'exit.json'), JSON.stringify({ code: 0, signal: null, seconds: 1 }));
  const result = run(env, '--attach', dir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /done/);
});

test('見込みを過ぎたら、タブを閉じずに待つのをやめる', () => {
  const { env, state } = fakeHerdr();
  const dir = tmp();
  const result = run(env, '--dir', dir, '--expect', '0.03', '--', 'echo started; sleep 4');
  assert.equal(result.status, 124);
  assert.match(result.stdout, /見込みの 0.03 分を過ぎても終わっていません/);
  assert.match(result.stdout, /started/);
  assert.match(result.stdout, /ログが最後に増えたのは \d+ 秒前/);
  assert.equal(fs.existsSync(path.join(state, 'closed')), false);
  assert.equal(fs.existsSync(path.join(dir, 'exit.json')), false);
  // 待ち直すと、終わった処理の結果を読める。
  const again = run(env, '--attach', dir, '--expect', '1');
  assert.equal(again.status, 0);
  assert.equal(fs.existsSync(path.join(state, 'closed')), true);
});

test('見込みの分は0より大きい数で書く', () => {
  const { env } = fakeHerdr();
  const result = run(env, '--expect', '0', '--', 'true');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--expect/);
});

test('終わりを記録しないままタブが閉じられたら、そう報告する', () => {
  const { env, state } = fakeHerdr();
  fs.writeFileSync(path.join(state, 'gone'), '');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ pane: 'w1:p1', tab: 'w1:t1' }));
  const result = run(env, '--attach', dir);
  assert.equal(result.status, 125);
  assert.match(result.stdout, /タブが閉じられました/);
});

test('タブ名の頭に、作ったセッションの名前を付ける', () => {
  const { env, state } = fakeHerdr();
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'sessions', '999.json'), JSON.stringify({ name: 'repo-ab' }));
  assert.equal(run({ ...env, HOME: home, USERPROFILE: home, CLAUDE_PID: '999' }, '--label', '検査', '--', 'exit 0').status, 0);
  assert.match(fs.readFileSync(path.join(state, 'create-args'), 'utf8'), /^repo-ab: 検査$/m);
});

test('セッションの名前が無ければ、リポジトリの名前を付ける', () => {
  const { env, state } = fakeHerdr();
  const repo = path.join(tmp(), 'my-repo');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q'], { cwd: repo });
  assert.equal(run({ ...env, CLAUDE_PID: '' }, '--cwd', repo, '--label', '検査', '--', 'exit 0').status, 0);
  assert.match(fs.readFileSync(path.join(state, 'create-args'), 'utf8'), /^my-repo: 検査$/m);
});

test('前の回の結果がある置き場には流さない', () => {
  const { env } = fakeHerdr();
  const dir = tmp();
  assert.equal(run(env, '--dir', dir, '--', 'exit 0').status, 0);
  const again = run(env, '--dir', dir, '--', 'exit 5');
  assert.equal(again.status, 1);
  assert.match(again.stderr, /前の回の結果/);
});

test('引用でまとめないコマンドは断る', () => {
  const { env } = fakeHerdr();
  const result = run(env, '--', 'npm', 'test');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /引用で1つ/);
});

test('hc の端末でも Herdr の中でもなければ流さない', () => {
  const { env } = fakeHerdr();
  const result = run({ ...env, HC_TERMINAL_ID: '', HERDR_ENV: '' }, '--', 'echo x');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /hc の端末でも Herdr の中でもない/);
});

test('Herdr のタブでは、置き場にログがあっても続けて流す', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ command: 'echo again', cwd: dir, pane: 'w1:p1', tab: 'w1:t1' }));
  fs.writeFileSync(path.join(dir, 'output.log'), 'first\n');
  const result = spawnSync('node', [script, '--runner', dir], { encoding: 'utf8', env: { ...process.env, SHELL: '/bin/sh' } });
  assert.equal(result.status, 0);
  assert.match(fs.readFileSync(path.join(dir, 'output.log'), 'utf8'), /^again$/m);
});

test('hc の端末では、HERDR_ENV=1 があっても hc の新しい端末で runner を流し、出力と終了コードを残して閉じる', () => {
  const { env, state, calls } = fakeHc();
  const dir = tmp();
  const result = run({ ...env, CLAUDE_PID: '' }, '--dir', dir, '--label', 'dev-server', '--cwd', dir, '--', 'echo out; exit 4');
  assert.equal(result.status, 4);
  assert.match(fs.readFileSync(path.join(dir, 'output.log'), 'utf8'), /^out$/m);
  const job = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));
  assert.equal(job.hc, 't9');
  const [started] = calls();
  // runner はシェルを挟まず端末のプログラムにする。呼び出し元が終わっても止めず、終わりの知らせは打ち込ませない。
  assert.match(started, /^run --json --bg --outlive-parent --no-notify --cwd \S+ --name [a-z0-9_-]{1,32} --label run_in_tab=.*: dev-server -- \S+node\S* \S+run-in-tab\.mjs --runner /);
  assert.equal(fs.existsSync(path.join(state, 'closed')), true);
});

test('hc の名前が使われていれば、-2 を付けて作り直す', () => {
  const { env, state, calls } = fakeHc();
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'sessions', '999.json'), JSON.stringify({ name: 'repo-ab' }));
  // タブ名「repo-ab: 検査」は、日本語が落ちて repo-ab になる。
  fs.writeFileSync(path.join(state, 'taken-repo-ab'), '');
  const result = run({ ...env, HOME: home, USERPROFILE: home, CLAUDE_PID: '999' }, '--label', '検査', '--', 'exit 0');
  assert.equal(result.status, 0);
  const names = calls()
    .filter((line) => line.startsWith('run '))
    .map((line) => line.match(/--name (\S+)/)[1]);
  assert.deepEqual(names, ['repo-ab', 'repo-ab-2']);
});

test('見込みを過ぎたら、hc の端末を閉じずに待つのをやめ、hc read を案内する', () => {
  const { env, state } = fakeHc();
  const dir = tmp();
  const result = run(env, '--dir', dir, '--expect', '0.03', '--', 'echo started; sleep 4');
  assert.equal(result.status, 124);
  assert.match(result.stdout, /hc read t9/);
  assert.equal(fs.existsSync(path.join(state, 'closed')), false);
});

test('hc の端末が終わりを記録しないまま終わった・消えたら、そう報告する', () => {
  for (const mark of ['finished', 'gone']) {
    const { env, state } = fakeHc();
    fs.writeFileSync(path.join(state, mark), '');
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ hc: 't9' }));
    const result = run(env, '--attach', dir);
    assert.equal(result.status, 125);
    assert.match(result.stdout, /タブが閉じられました/);
  }
});
