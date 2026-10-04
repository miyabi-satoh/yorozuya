// node --test scripts/guard-heavy-commands.test.cjs
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { isHeavy, loadConfig } = require('./guard-heavy-commands.cjs');

function projectWith(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-heavy-'));
  if (config !== undefined) {
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'heavy-commands.json'), config);
  }
  return dir;
}

const config = loadConfig(
  projectWith(
    JSON.stringify({
      defaults: true,
      heavy: ['just ci', 'just test', 'node e2e/run.mjs', { regex: '^node( -\\S+)* --test\\b' }],
      light: ['cargo check'],
    }),
  ),
);
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const heavy = (input, prePush = true) => isHeavy(input, config, () => prePush);

test('設定に書いたものと既定を重いとみなす', () => {
  for (const command of [
    'just ci',
    'cd /x && just test',
    'FOO="x y" just ci',
    'echo a | (cargo build)',
    'cargo t',
    'pnpm install',
    'pnpm run build',
    'node e2e/run.mjs',
    'node --test-concurrency=1 --test tests/a.mjs',
    'git push',
    'git -C /x/repo push -u origin HEAD',
    'echo "don\'t" && just ci && echo \'x\'',
    'cat <<EOF > f && just ci\nbody\nEOF',
    'time just ci',
    'timeout -s KILL 600 cargo test',
    'env X=1 just ci',
    'nice -n 10 just test',
    'if true; then just ci; fi',
  ]) {
    assert.equal(heavy(bash(command)), true, command);
  }
  assert.equal(heavy({ tool_name: 'Workflow', tool_input: { script: 'x' } }), true);
  assert.equal(heavy({ tool_name: 'PowerShell', tool_input: { command: 'just ci' } }), true);
});

test('引用・heredoc・here-string の中の語や、軽いものは見逃す', () => {
  for (const command of [
    'git commit -m "just ci を直す"',
    'grep -rn "cargo test" docs',
    "echo 'git push'",
    "python3 - <<'EOF'\njust ci\nEOF\necho done",
    "$s = @'\njust test\n'@\nWrite-Output $s",
    'git status',
    'just fmt',
    'ls just-ci',
    'cargo check',
    'node scripts/check.mjs',
  ]) {
    assert.equal(heavy(bash(command)), false, command);
  }
});

test('pre-push のフックが無ければ git push は軽い', () => {
  assert.equal(heavy(bash('git push'), false), false);
});

test('git -C の先のリポジトリで pre-push を見る', () => {
  const dirs = [];
  isHeavy(bash('git -C ../other push'), config, (dir) => dirs.push(dir));
  isHeavy(bash('git push'), config, (dir) => dirs.push(dir));
  assert.deepEqual(dirs, ['../other', '']);
});

test('push 先のリポジトリが読めなければ、pre-push を見ずに重いとみなす', () => {
  const noHook = () => false;
  assert.equal(isHeavy(bash('cd /other && git push'), config, noHook), true);
  assert.equal(isHeavy(bash('git -C "C:\\Users\\A B\\repo" push'), config, noHook), true);
  assert.equal(isHeavy(bash('git -C /x push'), config, noHook), false);
});

test('設定の形が違えば読めないとする', () => {
  for (const bad of [
    '{ "heavy": "just ci" }',
    '{ "defaults": "false" }',
    '{ "heavy": [""] }',
    '{ "light": [{ "regex": "" }] }',
    '[]',
    'null',
  ]) {
    assert.throws(() => loadConfig(projectWith(bad)), undefined, bad);
  }
});

test('強行の印があれば通す', () => {
  assert.equal(heavy(bash('CLAUDE_FORCE_HEAVY=1 just ci')), false);
  assert.equal(heavy({ tool_name: 'PowerShell', tool_input: { command: '$env:CLAUDE_FORCE_HEAVY=1; just ci' } }), false);
  assert.equal(heavy({ tool_name: 'Workflow', tool_input: { script: '// CLAUDE_FORCE_HEAVY=1' } }), false);
});

test('defaults が無ければ、書いたものだけを見る', () => {
  const own = loadConfig(projectWith(JSON.stringify({ heavy: ['just ci'] })));
  assert.equal(isHeavy(bash('just ci'), own, () => true), true);
  assert.equal(isHeavy(bash('cargo build'), own, () => true), false);
  assert.equal(isHeavy(bash('git push'), own, () => true), false);
  assert.equal(isHeavy({ tool_name: 'Workflow', tool_input: {} }, own, () => true), false);
});

function runHook(projectDir, command) {
  return spawnSync(process.execPath, [path.join(__dirname, 'guard-heavy-commands.cjs')], {
    input: JSON.stringify({ ...bash(command), cwd: projectDir }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    encoding: 'utf8',
  });
}

test('設定ファイルが無いプロジェクトでは何もしない', () => {
  const result = runHook(projectWith(), 'cargo build');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('設定ファイルが読めなければ、止めずに知らせる', () => {
  const result = runHook(projectWith('{ broken'), 'just ci');
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, undefined);
  assert.match(output.additionalContext, /heavy-commands\.json/);
});

test('読めない入力では何もしない', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'guard-heavy-commands.cjs')], {
    input: 'garbage',
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('CPU が埋まっていれば重い処理を拒む', async () => {
  const burners = os.cpus().map(() => spawn(process.execPath, ['-e', 'for(;;){}']));
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const project = projectWith(JSON.stringify({ heavy: ['just ci'] }));
    const denied = JSON.parse(runHook(project, 'just ci').stdout).hookSpecificOutput;
    assert.equal(denied.permissionDecision, 'deny');
    assert.equal(runHook(project, 'git status').stdout, '');
  } finally {
    for (const burner of burners) burner.kill();
  }
});
