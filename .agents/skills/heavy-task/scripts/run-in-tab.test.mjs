// node --test scripts/run-in-tab.test.mjs
// herdr は、タブの動きだけを真似た偽物を PATH の先頭に置いて試す。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./run-in-tab.mjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'run-in-tab-test-'));

function fakeHerdr() {
  const bin = tmp();
  const state = tmp();
  fs.writeFileSync(
    path.join(bin, 'herdr'),
    `#!/bin/sh
state='${state}'
case "$1 $2" in
  'tab create') printf '%s\n' "$@" > "$state/create-args"; echo '{"result":{"root_pane":{"pane_id":"w1:p1"},"tab":{"tab_id":"w1:t1"}}}' ;;
  'pane run') [ -e "$state/no-run" ] || sh -c "$4" >/dev/null 2>&1 & ;;
  'pane get') if [ -e "$state/gone" ]; then echo '{"error":{"code":"pane_not_found"}}'; exit 1; fi ;;
  'pane read') echo 'screen' ;;
  'tab close') touch "$state/closed" ;;
esac
`,
    { mode: 0o755 },
  );
  const env = { ...process.env, HERDR_ENV: '1', PATH: `${bin}${path.delimiter}${process.env.PATH}`, SHELL: '/bin/sh' };
  return { env, state };
}

function run(env, ...args) {
  return spawnSync('node', [script, ...args], { encoding: 'utf8', env });
}

test('出力と終了コードを残し、終わったらタブを閉じる', () => {
  const { env, state } = fakeHerdr();
  const dir = tmp();
  const result = run(env, '--dir', dir, '--', 'echo out; echo err >&2; exit 3');
  assert.equal(result.status, 3);
  assert.match(result.stdout, /exit=3/);
  const log = fs.readFileSync(path.join(dir, 'output.log'), 'utf8');
  assert.match(log, /\$ echo out/);
  assert.match(log, /^out$/m);
  assert.match(log, /^err$/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'exit.json'), 'utf8')).code, 3);
  assert.equal(fs.existsSync(path.join(state, 'closed')), true);
});

test('シグナルで落ちた処理は、シグナルの名前を残す', () => {
  const { env } = fakeHerdr();
  const dir = tmp();
  const result = run(env, '--dir', dir, '--', 'kill -KILL $$');
  assert.equal(result.status, 137);
  assert.match(result.stdout, /signal=SIGKILL/);
});

test('タブの側が止められたら、受けたシグナルを残す', async () => {
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

test('止める知らせを無視する処理でも、理由を残して終わる', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ command: "trap '' HUP; sleep 30 & echo $! > pid; wait", cwd: dir }));
  const child = spawn('node', [script, '--runner', dir], { stdio: 'ignore', env: { ...process.env, SHELL: '/bin/sh' } });
  while (!fs.existsSync(path.join(dir, 'output.log'))) await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise((resolve) => setTimeout(resolve, 200));
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
  assert.equal(run({ ...env, HOME: home, CLAUDE_PID: '999' }, '--label', '検査', '--', 'exit 0').status, 0);
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

test('Herdr の外では流さない', () => {
  const { env } = fakeHerdr();
  const result = run({ ...env, HERDR_ENV: '' }, '--', 'echo x');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Herdr の中でない/);
});
