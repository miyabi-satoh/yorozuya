#!/usr/bin/env node
// コマンドを Herdr の別のタブで流し、出力・終了コード・止まった理由をファイルに残す。
//
//   node run-in-tab.mjs [--label <名前>] [--cwd <場所>] [--dir <置き場>] [--tail <行数>] -- '<コマンド>'
//   node run-in-tab.mjs --attach <置き場>    待つ側だけが打ち切られたときに、待ち直す
//
// 待つ側はタブの中の処理と別のプロセスなので、待つ側が打ち切られてもタブの処理は続く。
// 置き場には job.json・output.log・exit.json ができる。
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const POLL_MS = 1000;
// シェルの起動が遅い場合より長く、起動に失敗したのに気づくのが遅れすぎない長さ。
const START_TIMEOUT_MS = 30_000;
// exit の後に残った子孫が標準出力を握っていても、待ち続けない。
const OUTPUT_DRAIN_MS = 2000;
const DEFAULT_TAIL_LINES = 40;
const TAIL_BYTES = 256 * 1024;
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

const herdr = (...args) => execFileSync('herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const jobFile = (dir) => path.join(dir, 'job.json');
const logFile = (dir) => path.join(dir, 'output.log');
const exitFile = (dir) => path.join(dir, 'exit.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function shellFor(command) {
  if (process.platform === 'win32') return ['pwsh', ['-NoProfile', '-Command', command]];
  return [process.env.SHELL || 'sh', ['-c', command]];
}

// タブの中で動く側。出力はタブの画面とログの両方へ出す。
function runner(dir) {
  const job = readJson(jobFile(dir));
  if (!job) {
    console.error(`job.json を読めません: ${dir}`);
    process.exit(2);
  }
  const log = fs.openSync(logFile(dir), 'a');
  const startedAt = new Date();
  const write = (stream, chunk) => {
    stream.write(chunk);
    fs.writeSync(log, chunk);
  };
  write(process.stdout, `[run-in-tab] ${startedAt.toISOString()} 開始\n[run-in-tab] cwd: ${job.cwd}\n[run-in-tab] $ ${job.command}\n`);

  const [shell, args] = shellFor(job.command);
  // 入力を待つコマンドが誰にも気づかれず止まり続けないよう、標準入力は渡さない。
  const child = spawn(shell, args, { cwd: job.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => write(process.stdout, chunk));
  child.stderr.on('data', (chunk) => write(process.stderr, chunk));

  let finished = false;
  let interruptedBy = null;
  const finish = (code, signal, error) => {
    if (finished) return;
    finished = true;
    const endedAt = new Date();
    const result = {
      code,
      signal,
      interruptedBy,
      error,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      seconds: Math.round((endedAt - startedAt) / 1000),
    };
    write(process.stdout, `[run-in-tab] ${endedAt.toISOString()} 終了 ${describe(result)}\n`);
    // 途中まで書いた exit.json を待つ側が読まないよう、rename で置く。
    fs.writeFileSync(`${exitFile(dir)}.tmp`, JSON.stringify(result));
    fs.renameSync(`${exitFile(dir)}.tmp`, exitFile(dir));
    process.exit(exitCode(result));
  };
  for (const name of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
    process.on(name, () => {
      interruptedBy = name;
      child.kill(name);
    });
  }
  child.on('error', (error) => finish(127, null, error.message));
  child.on('exit', (code, signal) => setTimeout(() => finish(code, signal), OUTPUT_DRAIN_MS));
  child.on('close', (code, signal) => finish(code, signal));
}

function describe({ code, signal, interruptedBy, error, seconds }) {
  const parts = [signal ? `signal=${signal}` : `exit=${code}`];
  if (interruptedBy) parts.push(`タブの側が ${interruptedBy} を受けた`);
  if (error) parts.push(`起動できなかった: ${error}`);
  parts.push(`${seconds}秒`);
  return parts.join(' ');
}

function exitCode({ code, signal }) {
  return code ?? 128 + (SIGNALS[signal] ?? 0);
}

function tailOf(file, lines) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return '(ログがありません)';
  }
  const { size } = fs.fstatSync(fd);
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, size - length);
  fs.closeSync(fd);
  return buffer.toString('utf8').trimEnd().split('\n').slice(-lines).join('\n');
}

function paneIsGone(pane) {
  try {
    herdr('pane', 'get', pane);
    return false;
  } catch (error) {
    // サーバーに一時的につながらないだけなら、消えたとみなさない。
    return String(error.stdout).includes('pane_not_found') || String(error.stderr).includes('pane_not_found');
  }
}

function closeTab(tab) {
  try {
    herdr('tab', 'close', tab);
  } catch {
    // 既に閉じられていてもよい。
  }
}

async function waitFor(dir, tailLines) {
  const job = readJson(jobFile(dir));
  if (!job) {
    console.error(`job.json を読めません: ${dir}`);
    return 2;
  }
  const waitStarted = Date.now();
  for (;;) {
    const result = readJson(exitFile(dir));
    if (result) {
      console.log(`--- ログの末尾 ${tailLines} 行 ---\n${tailOf(logFile(dir), tailLines)}\n---`);
      console.log(`${describe(result)}\nログ: ${logFile(dir)}`);
      closeTab(job.tab);
      return exitCode(result);
    }
    if (paneIsGone(job.pane) && !readJson(exitFile(dir))) {
      console.log(`--- ログの末尾 ${tailLines} 行 ---\n${tailOf(logFile(dir), tailLines)}\n---`);
      console.log(`終わりを記録しないままタブが閉じられました。\nログ: ${logFile(dir)}`);
      return 125;
    }
    if (!fs.existsSync(logFile(dir)) && Date.now() - waitStarted > START_TIMEOUT_MS) {
      let screen = '';
      try {
        screen = herdr('pane', 'read', job.pane, '--lines', '20');
      } catch {
        // 画面を読めなくても、始まらなかったことは伝える。
      }
      console.log(`タブの中で処理が始まりませんでした。タブは残しています（${job.tab}）。\n${screen}`);
      return 125;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function parseArgs(argv) {
  const options = { tail: DEFAULT_TAIL_LINES };
  const separator = argv.indexOf('--');
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  if (separator !== -1) options.command = argv.slice(separator + 1).join(' ');
  for (let i = 0; i < flags.length; i += 2) {
    const name = flags[i].replace(/^--/, '');
    if (!['label', 'cwd', 'dir', 'tail', 'attach', 'runner'].includes(name) || flags[i + 1] === undefined) {
      throw new Error(`読めない引数: ${flags[i]}`);
    }
    options[name] = name === 'tail' ? Number(flags[i + 1]) : flags[i + 1];
  }
  return options;
}

function defaultDir(label) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const name = label.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40);
  const root = path.join(os.tmpdir(), 'run-in-tab');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, `${stamp}-${name}-`));
}

function start({ command, label, cwd, dir }) {
  const name = label ?? command.trim().split(/\s+/).slice(0, 2).join(' ');
  const jobDir = dir ? path.resolve(dir) : defaultDir(name);
  fs.mkdirSync(jobDir, { recursive: true });
  const jobCwd = path.resolve(cwd ?? process.cwd());
  const workspace = process.env.HERDR_WORKSPACE_ID ? ['--workspace', process.env.HERDR_WORKSPACE_ID] : [];
  const created = JSON.parse(herdr('tab', 'create', ...workspace, '--cwd', jobCwd, '--label', name, '--no-focus')).result;
  const job = { command, cwd: jobCwd, label: name, pane: created.root_pane.pane_id, tab: created.tab.tab_id };
  fs.writeFileSync(jobFile(jobDir), JSON.stringify(job, null, 2));
  // 待つ側が打ち切られても待ち直せるよう、始めにここへ出す。
  console.log(`タブ: ${name}（${job.tab}）\n置き場: ${jobDir}`);
  // herdr は引数を空白でつなぐので、空白を含むパスは引用したまま1つの文字列で渡す。
  herdr('pane', 'run', job.pane, `node "${fileURLToPath(import.meta.url)}" --runner "${jobDir}"`);
  return jobDir;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (options.runner) {
    runner(options.runner);
    return null;
  }
  if (process.env.HERDR_ENV !== '1') {
    console.error('Herdr の中でないので、タブで流せません（HERDR_ENV=1 でない）。');
    return 2;
  }
  if (options.attach) return waitFor(options.attach, options.tail);
  if (!options.command?.trim()) {
    console.error("コマンドがありません: run-in-tab.mjs [--label <名前>] -- '<コマンド>'");
    return 2;
  }
  return waitFor(start(options), options.tail);
}

main().then(
  (code) => {
    if (code !== null) process.exit(code);
  },
  (error) => {
    console.error(error.message);
    process.exit(1);
  },
);
