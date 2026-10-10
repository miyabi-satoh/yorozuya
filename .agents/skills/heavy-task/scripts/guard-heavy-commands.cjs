#!/usr/bin/env node
// PreToolUse の hook。マシンが厳しいときに、重い処理 (ビルド・テスト・push など) を始めさせない。
// 目安は heavy-task skill（このスキルの SKILL.md）に合わせる。
// CPU の空きが 10% を切っていれば止める。
//
// 何が重いかはプロジェクトによるので、プロジェクトの `.claude/heavy-commands.json` に書く。
// このファイルが無いプロジェクトでは、既定だけを見る (置き忘れたプロジェクトで何も止まらないのを避ける)。
//
//   {
//     "defaults": true,                        // 下の DEFAULT_HEAVY と Workflow・pre-push のある git push も重いとみなす。書かなければ true
//     "heavy": ["just ci", "node e2e/run.mjs"], // コマンドの頭の語の並び。語の並びで書けないものは { "regex": "..." }
//     "light": ["cargo check"]                  // heavy や既定から外すもの
//   }
//
// 引用の中身と heredoc・here-string の本文は見ず、コマンドの位置 (行頭、`;` `&` `|` `(` の後) に来たものだけを見る。
// 例外は `herdr pane run <ペイン> <コマンド>` で、ペインへ送るコマンドも同じように見る (ビルドやテストもペインで流すことがあるため)。
// 測れないときや入力が読めないときは、何もせずに通す (hook の不具合で作業を止めないため)。
// 3つの OS で同じに動くよう、負荷は node の os モジュールで測る。

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ユーザーが強行を認めたときに、ツールの入力に含めて通すための印。
const FORCE_MARK = 'CLAUDE_FORCE_HEAVY=1';
const CPU_IDLE_MIN = 10;
const CONFIG_PATH = path.join('.claude', 'heavy-commands.json');

const DEFAULT_HEAVY = [
  ...['b', 'build', 't', 'test', 'c', 'check', 'clippy', 'r', 'run', 'install'].map((sub) => `cargo ${sub}`),
  ...['pnpm', 'npm', 'yarn'].flatMap((pm) =>
    ['install', 'i', 'ci', 'add', 'build', 'test', 'run build', 'run test'].map((sub) => `${pm} ${sub}`),
  ),
  'go build',
  'go test',
  'docker build',
  'docker compose up',
];

// heredoc・here-string の本文と引用の中身は、コミットメッセージや検索語なので見ない。
// quoted を渡すと、空にした引用の中身を、出てきた順に足す。
function stripLiterals(command, quoted = []) {
  const lines = command.replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, "''").split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    // 開始の行は残し、次の行から終わりの語の行までを飛ばす。
    for (const match of lines[i].matchAll(/<<-?\s*(['"]?)(\w+)\1/g)) {
      while (i + 1 < lines.length && lines[i + 1].trim() !== match[2]) i++;
      i++;
    }
  }
  // 引用は左から順に読み、中身を空にする (二重引用符の中の ' などを取り違えないため)。
  let out = '';
  const text = kept.join('\n');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += c === '"' && text[j] === '\\' ? 2 : 1;
      const content = text.slice(i + 1, j);
      quoted.push(c === '"' ? content.replace(/\\(["\\$`])/g, '$1') : content);
      out += c + c;
      i = j;
    } else {
      out += c;
    }
  }
  return out;
}

// コマンドの頭に来ても、それ自体はコマンドの名前ではない語。
const WRAPPERS = new Set(['time', 'env', 'nohup', 'exec', 'command', 'then', 'do', 'else', '{', '!']);

// 環境変数の前置や time・timeout などを除いた語の並びにする。
function commandWords(segment) {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  for (;;) {
    if (/^[A-Za-z_]\w*=/.test(words[0] ?? '') || WRAPPERS.has(words[0])) {
      words.shift();
    } else if (words[0] === 'timeout' || words[0] === 'nice') {
      // timeout [-k 5] [-s KILL] 600 …、nice -n 10 …
      words.shift();
      while (words[0]?.startsWith('-')) words.splice(0, ['-k', '-s', '-n'].includes(words[0]) ? 2 : 1);
      if (words[0] !== undefined && /^\d/.test(words[0])) words.shift();
    } else {
      break;
    }
  }
  return words;
}

// `herdr pane run <ペイン> <コマンド>` なら、ペインへ送るコマンドを返す。引用で渡していれば、その中身に戻す。
// quotes は、この区切りに出てくる引用の中身 (出てきた順)。
function paneCommand(segment, quotes) {
  const sent = segment.match(/^(.*?\bherdr\s+pane\s+run\s+\S+\s+)(\S.*)$/s);
  if (!sent) return null;
  let next = (sent[1].match(/''|""/g) ?? []).length;
  return sent[2].replace(/''|""/g, () => quotes[next++] ?? '');
}

// コマンドの位置ごとの語の並びにする。
function commandSegments(command, nested = false) {
  const quoted = [];
  const segments = [];
  let seen = 0;
  for (const segment of stripLiterals(command, quoted).split(/[;&|()\n]/)) {
    const quotes = quoted.slice(seen, (seen += (segment.match(/''|""/g) ?? []).length));
    const words = commandWords(segment);
    if (words.length === 0) continue;
    segments.push(words);
    // ペインへ送るコマンドの中の `herdr pane run` までは追わない。
    const sent = !nested && words[0] === 'herdr' ? paneCommand(segment, quotes) : null;
    if (sent === null) continue;
    for (const inner of commandSegments(sent, true)) segments.push(Object.assign(inner, { inPane: true }));
  }
  return segments;
}

function toMatcher(spec) {
  if (typeof spec === 'string' && spec.trim()) {
    const prefix = spec.trim().split(/\s+/);
    return (words) => prefix.every((word, i) => words[i] === word);
  }
  if (spec && typeof spec.regex === 'string' && spec.regex) {
    const regex = new RegExp(spec.regex);
    return (words) => regex.test(words.join(' '));
  }
  throw new Error(`読めない指定: ${JSON.stringify(spec)}`);
}

// `git -C <path> push` のように、push の前のオプションを飛ばす。push なら、-C の先 (無ければ '') を返す。
function gitPushDir(words) {
  if (words[0] !== 'git') return null;
  let dir = '';
  for (let i = 1; i < words.length; i++) {
    if (words[i] === 'push') return dir;
    if (!words[i].startsWith('-')) return null;
    if (words[i] === '-C') dir = words[i + 1] ?? '';
    if (['-C', '-c', '--git-dir', '--work-tree'].includes(words[i])) i++;
  }
  return null;
}

function hasPrePushHook(cwd) {
  try {
    const hook = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-push'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    return fs.existsSync(hook);
  } catch {
    return false;
  }
}

function specList(raw, key) {
  const value = raw[key] ?? [];
  if (!Array.isArray(value)) throw new Error(`${key} は配列で書く`);
  return value.map(toMatcher);
}

// 設定を読んで、判定に使う形にする。ファイルが無ければ既定だけ。形が違えば throw する。
function loadConfig(projectDir) {
  let text = '{}';
  try {
    text = fs.readFileSync(path.join(projectDir, CONFIG_PATH), 'utf8');
  } catch {
    // 無ければ既定だけを見る。
  }
  const raw = JSON.parse(text);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('オブジェクトで書く');
  const defaults = raw.defaults ?? true;
  if (typeof defaults !== 'boolean') throw new Error('defaults は true か false で書く');
  const heavy = [...(defaults ? DEFAULT_HEAVY.map(toMatcher) : []), ...specList(raw, 'heavy')];
  return { defaults, heavy, light: specList(raw, 'light') };
}

// 重い処理なら true。prePush(dir) は、dir (空ならいまの場所) のリポジトリに pre-push のフックがあるかを返す。
// cd の後や、-C の先が引用で読めないとき、ペインへ送る push は、どのリポジトリか分からないので重いとみなす。
function isHeavy(input, config, prePush) {
  if (JSON.stringify(input.tool_input ?? {}).includes(FORCE_MARK)) return false;
  if (input.tool_name === 'Workflow') return config.defaults;
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return false;
  let movedDir = false;
  return commandSegments(command).some((words) => {
    if (words[0] === 'cd' || words[0] === 'pushd' || words[0] === 'Set-Location') movedDir = true;
    if (config.light.some((match) => match(words))) return false;
    if (config.heavy.some((match) => match(words))) return true;
    const pushDir = config.defaults ? gitPushDir(words) : null;
    if (pushDir === null) return false;
    if (movedDir || words.inPane || pushDir.includes('""') || pushDir.includes("''")) return true;
    return prePush(pushDir);
  });
}

function cpuTotals() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    for (const time of Object.values(cpu.times)) total += time;
  }
  return { idle, total };
}

// 1秒の間の CPU の空き (%)。
async function cpuIdlePercent() {
  const before = cpuTotals();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const after = cpuTotals();
  const total = after.total - before.total;
  return total > 0 ? ((after.idle - before.idle) / total) * 100 : null;
}

function output(hookSpecificOutput) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...hookSpecificOutput } }));
}

function denyReason(input, idle) {
  return [
    `CPU の空きが ${idle.toFixed(1)}% で、10% を切っているため、重い処理を止めました。`,
    'heavy-wait の mod があれば、空きを測り続け、空いたとき (15分たっても厳しいときも) にプラグインのメッセージで知らせるので、その間は軽い作業を進めてください。mod が無ければ、5分待って確かめ直すのを3回 (計15分) 繰り返します。',
    `それでも厳しいままなら、待ち続けるか強行するかをユーザーに確かめてください。強行を認められたときだけ、${FORCE_MARK} を含めて実行し直します。`,
    input.tool_name === 'Workflow'
      ? `Workflow では、script に // ${FORCE_MARK} の注釈を足してください。`
      : `Bash ではコマンドの頭に ${FORCE_MARK} を付け、PowerShell では $env:${FORCE_MARK}; を前に置いてください。`,
  ].join('\n');
}

async function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  if (!projectDir) return;

  let config;
  try {
    config = loadConfig(projectDir);
  } catch (error) {
    output({ additionalContext: `${CONFIG_PATH} を読めないため、重い処理の見張りが効いていません: ${error.message}` });
    return;
  }
  const cwd = input.cwd || projectDir;
  if (!isHeavy(input, config, (dir) => hasPrePushHook(path.resolve(cwd, dir)))) return;

  const idle = await cpuIdlePercent();
  if (idle !== null && idle < CPU_IDLE_MIN) {
    output({ permissionDecision: 'deny', permissionDecisionReason: denyReason(input, idle) });
  }
}

if (require.main === module && process.argv.includes('--idle')) {
  // heavy-wait の mod が、止めた後に空きを測り直すのに使う。測れなければ何も出さない。
  cpuIdlePercent()
    .then((idle) => idle !== null && process.stdout.write(`${idle.toFixed(1)}\n`))
    .catch(() => {});
} else if (require.main === module) {
  main().catch(() => {});
} else {
  module.exports = { commandSegments, isHeavy, loadConfig, FORCE_MARK };
}
