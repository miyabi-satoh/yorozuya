// node --test scripts/run-in-tab.test.mjs
// herdr と orca は、タブの動きだけを真似た偽物を PATH の先頭に置いて試す。
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
  # 本物の herdr のように送ったらすぐ返るよう、後ろで流す側の出力も herdr の出力から切り離す。
  'pane run') { [ -e "$state/no-run" ] || sh -c "$4"; } >/dev/null 2>&1 & ;;
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

// Orca の偽物。出力の形は Orca 1.4.268 の --json に合わせる。send は --text の文（末尾の CR を外す）を後ろで流す。
function fakeOrca() {
  const bin = tmp();
  const state = tmp();
  fs.writeFileSync(
    path.join(bin, 'orca'),
    `#!/bin/sh
state='${state}'
sub="$1 $2"
shift 2
text=''
while [ $# -gt 0 ]; do
  case "$1" in --text) text="$2"; shift ;; esac
  shift
done
case "$sub" in
  'terminal create') if [ -e "$state/no-handle" ]; then echo '{"ok":true,"result":{"terminal":{}}}'; else echo '{"ok":true,"result":{"terminal":{"handle":"term_1"}}}'; fi ;;
  'terminal send') printf '%s' "$text" > "$state/sent"; { [ -e "$state/no-run" ] || sh -c "$(printf '%s' "$text" | tr -d '\\r')"; } >/dev/null 2>&1 & echo '{"ok":true,"result":{"send":{"accepted":true}}}' ;;
  'terminal show') if [ -e "$state/gone" ]; then echo '{"ok":false,"error":{"code":"terminal_handle_stale"}}'; exit 1; fi; echo '{"ok":true,"result":{"terminal":{"connected":true}}}' ;;
  'terminal read') echo '{"ok":true,"result":{"terminal":{"tail":["~ ❯",""],"source":"screen"}}}' ;;
  'terminal close') touch "$state/closed"; echo '{"ok":true,"result":{}}' ;;
esac
`,
    { mode: 0o755 },
  );
  // HERDR_ENV を外すのは、Herdr の中で試しても Orca の側を通すため。
  const env = { ...process.env, HERDR_ENV: '', ORCA_TERMINAL_HANDLE: 'term_self', ORCA_WORKTREE_ID: 'r1::/w', PATH: `${bin}${path.delimiter}${process.env.PATH}`, SHELL: '/bin/sh' };
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

test('Herdr の中でも Orca の端末でもなければ流さない', () => {
  const { env } = fakeHerdr();
  const result = run({ ...env, HERDR_ENV: '', ORCA_TERMINAL_HANDLE: '' }, '--', 'echo x');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Herdr の中でも Orca の端末でもない/);
});

test('Orca の端末では、同じ作業フォルダーにタブを作り、出力と終了コードを残して閉じる', () => {
  const { env, state } = fakeOrca();
  const dir = tmp();
  const result = run(env, '--dir', dir, '--', 'echo out; exit 4');
  assert.equal(result.status, 4);
  assert.match(fs.readFileSync(path.join(dir, 'output.log'), 'utf8'), /^out$/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')).terminal, 'term_1');
  // 起動のコマンドにせず、シェルへ打ち込む（末尾は Enter の CR）。
  assert.match(fs.readFileSync(path.join(state, 'sent'), 'utf8'), /--runner ".*"\r$/);
  assert.equal(fs.existsSync(path.join(state, 'closed')), true);
});

test('Orca の端末が終わりを記録しないまま閉じられたら、そう報告する', () => {
  const { env, state } = fakeOrca();
  fs.writeFileSync(path.join(state, 'gone'), '');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ terminal: 'term_1' }));
  const result = run(env, '--attach', dir);
  assert.equal(result.status, 125);
  assert.match(result.stdout, /タブが閉じられました/);
});

test('Orca の端末からは、同じ置き場の処理を2回は流さない', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ command: 'echo again', cwd: dir, terminal: 'term_1' }));
  fs.writeFileSync(path.join(dir, 'output.log'), 'first\n');
  const result = spawnSync('node', [script, '--runner', dir], { encoding: 'utf8', env: { ...process.env, SHELL: '/bin/sh' } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /一度流れています/);
  assert.equal(fs.readFileSync(path.join(dir, 'output.log'), 'utf8'), 'first\n');
});

test('Herdr のタブでは、置き場にログがあっても分ける前のとおり続けて流す', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ command: 'echo again', cwd: dir, pane: 'w1:p1', tab: 'w1:t1' }));
  fs.writeFileSync(path.join(dir, 'output.log'), 'first\n');
  const result = spawnSync('node', [script, '--runner', dir], { encoding: 'utf8', env: { ...process.env, SHELL: '/bin/sh' } });
  assert.equal(result.status, 0);
  assert.match(fs.readFileSync(path.join(dir, 'output.log'), 'utf8'), /^again$/m);
});

test('Orca の端末を作った出力にハンドルが無ければ、流さずに止まる', () => {
  const { env, state } = fakeOrca();
  fs.writeFileSync(path.join(state, 'no-handle'), '');
  const dir = tmp();
  const result = run(env, '--dir', dir, '--', 'echo x');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ハンドルが無い/);
  assert.equal(fs.existsSync(path.join(state, 'sent')), false);
});
