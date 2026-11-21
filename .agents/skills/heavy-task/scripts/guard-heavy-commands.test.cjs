// node --test scripts/guard-heavy-commands.test.cjs
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { commandSegments, isHeavy, loadConfig, runsOutsideTab } = require('./guard-heavy-commands.cjs');

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

test('run-in-tab へ渡す重いコマンドは、重いがタブの外ではないとみなす', () => {
  const outside = (command) => runsOutsideTab(bash(command), config, () => true);
  for (const command of [
    "node ~/.agents/skills/heavy-task/scripts/run-in-tab.mjs -- 'just ci'",
    "node ~/x/run-in-tab.mjs --label 'CI の検査' --cwd /x -- 'cd /y && cargo test'",
    'herdr pane run w1:p1 "just ci"',
    "cd /x && node run-in-tab.mjs -- 'git push'",
  ]) {
    assert.equal(heavy(bash(command)), true, command);
    assert.equal(outside(command), false, command);
  }
  for (const command of ['just ci', 'cargo test | tail', 'git push', "herdr pane read w1:p1; just ci", 'CLAUDE_X=1 just ci', "node x.mjs -- 'just fmt' && just ci"]) {
    assert.equal(outside(command), true, command);
  }
  for (const command of ['git status', "node ~/x/run-in-tab.mjs -- 'just fmt'", "node ~/x/run-in-tab.mjs --attach /x", 'CLAUDE_FORCE_HEAVY=1 just ci']) {
    assert.equal(outside(command), false, command);
  }
  assert.equal(runsOutsideTab({ tool_name: 'Workflow', tool_input: { script: 'x' } }, config, () => true), false);
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
    'git commit -m "herdr pane run w1:p1 just ci を足す"',
    'herdr pane run w1:p1 "just fmt"',
    'herdr pane read w1:p1',
  ]) {
    assert.equal(heavy(bash(command)), false, command);
  }
});

test('herdr pane run でペインへ送るコマンドも見る', () => {
  for (const command of [
    'herdr pane run w1:p1 "just ci"',
    "herdr pane run w1:p1 'cd app && pnpm build'",
    'herdr pane run w1:p1 pnpm test',
    'herdr pane run "w1:p1" "PORT=3000 just test"',
    'cd /tmp && herdr pane run w1:p1 "just ci"',
    'echo "start" && herdr pane run w1:p1 "echo \\"x\\"; just ci"',
  ]) {
    assert.equal(heavy(bash(command)), true, command);
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

test('orca terminal で端末へ送るコマンドも、重いがタブの外ではないとみなす', () => {
  const outside = (command) => runsOutsideTab(bash(command), config, () => true);
  for (const command of [
    'orca terminal create --worktree active --title t --command "just ci" --json',
    "orca terminal send --terminal term_1 --text 'cargo test' --enter",
    'orca terminal split --terminal term_1 --command "pnpm build"',
    'orca terminal send --terminal t --text="npm run build" --enter',
    "orca terminal create --command='cargo test'",
  ]) {
    assert.equal(heavy(bash(command)), true, command);
    assert.equal(outside(command), false, command);
  }
  for (const command of ['orca terminal send --terminal term_1 --text "just fmt" --enter', 'orca terminal read --terminal term_1 --screen', 'orca terminal list --json']) {
    assert.equal(heavy(bash(command)), false, command);
  }
});

test('hc run・hc send で端末へ送るコマンドも、重いがタブの外ではないとみなす。hc exec は端末を作らないので見ない', () => {
  const outside = (command) => runsOutsideTab(bash(command), config, () => true);
  for (const command of [
    'hc run --bg --rm --no-notify --name build -- cargo build --release',
    'hc run "cd app && pnpm build"',
    'hc run --on vps --cwd=/srv/app cargo test',
    "hc send t3 'just ci'",
    'hc send --if idle build "npm run build"',
  ]) {
    assert.equal(heavy(bash(command)), true, command);
    assert.equal(outside(command), false, command);
  }
  for (const command of ['hc send t3 "just fmt"', 'hc read t3 --lines 40', 'hc ls', 'git commit -m "hc run cargo test を足す"', 'hc exec cargo build']) {
    assert.equal(heavy(bash(command)), false, command);
  }
});

test('ほかの道具の引数に hc run が混ざっても、hc の形では読まない（Herdr・Orca・run-in-tab の読み方のまま）', () => {
  const sent = (command) => commandSegments(command).filter((words) => words.inPane).map((words) => words.join(' '));
  assert.deepEqual(sent('orca terminal send --terminal x --text cmd -- hc run foo'), ['cmd']);
  assert.deepEqual(sent("node run-in-tab.mjs --label fix-hc run -- 'npm test'"), ['npm test']);
  assert.deepEqual(sent('herdr pane run w1:p1 "hc run cargo test"'), ['hc run cargo test']);
  // hc はパスで書いても拾う。
  assert.deepEqual(sent('/usr/local/bin/hc run -- just ci'), ['just ci']);
  assert.deepEqual(sent('~/.local/bin/hc send t3 "cargo test"'), ['cargo test']);
});

test('強行の印があれば通す', () => {
  assert.equal(heavy(bash('CLAUDE_FORCE_HEAVY=1 just ci')), false);
  assert.equal(heavy({ tool_name: 'PowerShell', tool_input: { command: '$env:CLAUDE_FORCE_HEAVY=1; just ci' } }), false);
  assert.equal(heavy({ tool_name: 'Workflow', tool_input: { script: '// CLAUDE_FORCE_HEAVY=1' } }), false);
});

test('ペインへ送る git push は、pre-push を見ずに重いとみなす', () => {
  // ペインがどのリポジトリにいるかは分からない。
  assert.equal(heavy(bash('herdr pane run w1:p1 "git push"'), false), true);
  assert.equal(heavy(bash('git push'), false), false);
});

test('defaults が false なら、書いたものだけを見る', () => {
  const own = loadConfig(projectWith(JSON.stringify({ defaults: false, heavy: ['just ci'] })));
  assert.equal(isHeavy(bash('just ci'), own, () => true), true);
  assert.equal(isHeavy(bash('cargo build'), own, () => true), false);
  assert.equal(isHeavy(bash('git push'), own, () => true), false);
  assert.equal(isHeavy({ tool_name: 'Workflow', tool_input: {} }, own, () => true), false);
});

// 試す側が hc・Orca の端末や Herdr の中でも、タブへ回す判定に入らないよう、既定ではどれも外す。
function runHook(projectDir, command, env = {}) {
  return spawnSync(process.execPath, [path.join(__dirname, 'guard-heavy-commands.cjs')], {
    input: JSON.stringify({ ...bash(command), cwd: projectDir }),
    env: { ...process.env, HC_TERMINAL_ID: '', HERDR_ENV: '', ORCA_TERMINAL_HANDLE: '', CLAUDE_PROJECT_DIR: projectDir, ...env },
    encoding: 'utf8',
  });
}

test('Herdr の中か Orca の端末では、重い処理をタブの外で流すのを止め、その道具の名前で案内する', () => {
  const project = projectWith(JSON.stringify({ heavy: ['just ci'] }));
  const reason = (env) => JSON.parse(runHook(project, 'just ci', env).stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason({ ORCA_TERMINAL_HANDLE: 'term_1' }), /^重い処理は、Orca の別のタブで流してください/);
  assert.match(reason({ HERDR_ENV: '1', ORCA_TERMINAL_HANDLE: 'term_1' }), /^重い処理は、Herdr の別のタブで流してください/);
  assert.equal(runHook(project, "node run-in-tab.mjs -- 'just ci'", { ORCA_TERMINAL_HANDLE: 'term_1' }).stdout, '');
});

test('hc の端末では、HERDR_ENV=1 を引き継いでいても hc の別の端末で流すよう案内する', () => {
  const project = projectWith(JSON.stringify({ heavy: ['just ci'] }));
  const out = runHook(project, 'just ci', { HC_TERMINAL_ID: 't3', HERDR_ENV: '1' });
  assert.match(JSON.parse(out.stdout).hookSpecificOutput.permissionDecisionReason, /^重い処理は、hc の別の端末で流してください/);
  assert.equal(runHook(project, "hc run --bg --name ci -- just ci", { HC_TERMINAL_ID: 't3' }).stdout, '');
});

test('defaults を書かなければ、既定も見る', () => {
  const own = loadConfig(projectWith(JSON.stringify({ heavy: ['just ci'] })));
  assert.equal(isHeavy(bash('just ci'), own, () => true), true);
  assert.equal(isHeavy(bash('cargo build'), own, () => true), true);
});

test('設定ファイルが無いプロジェクトでは、既定だけを見る', () => {
  const none = loadConfig(projectWith());
  assert.equal(isHeavy(bash('cargo build'), none, () => true), true);
  assert.equal(isHeavy(bash('git push'), none, () => true), true);
  assert.equal(isHeavy(bash('git push'), none, () => false), false);
  assert.equal(isHeavy({ tool_name: 'Workflow', tool_input: {} }, none, () => true), true);
  assert.equal(isHeavy(bash('just ci'), none, () => true), false);
  const result = runHook(projectWith(), 'git status');
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
