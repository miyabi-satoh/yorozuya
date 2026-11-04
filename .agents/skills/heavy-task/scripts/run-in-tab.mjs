#!/usr/bin/env node
// コマンドを Herdr の別のタブで流し、出力・終了コード・止まった理由をファイルに残す。
//
//   node run-in-tab.mjs [--label <用途>] [--cwd <場所>] [--dir <置き場>] [--tail <行数>] -- '<コマンド>'
//   node run-in-tab.mjs --attach <置き場>    待つ側だけが打ち切られたときに、待ち直す
//
// 待つ側はタブの中の処理と別のプロセスなので、待つ側が打ち切られてもタブの処理は続く。
// 置き場には job.json・output.log・exit.json ができる。
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const POLL_MS = 1000;
// シェルの起動が遅い場合より長く、起動に失敗したのに気づくのが遅れすぎない長さ。
const START_TIMEOUT_MS = 30_000;
// exit の後に残った子孫が標準出力を握っていても、待ち続けない。
const OUTPUT_DRAIN_MS = 2000;
const DEFAULT_TAIL_LINES = 40;
const TAIL_BYTES = 256 * 1024;
// 止める知らせを無視する処理は、この後で強制終了する。
const INTERRUPT_GRACE_MS = 5000;
const PANE_CHECK_MS = 5000;
// タブが閉じると、タブの側はこの間に exit.json を書く。INTERRUPT_GRACE_MS と OUTPUT_DRAIN_MS の和より長くする。
const CLOSED_TAB_GRACE_MS = 10_000;
// 記録の無いまま終わったとき。コマンドの終了コードと区別できるよう、文でも伝える。
const EXIT_NO_RECORD = 125;

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
  // pwsh の -Command は、外部コマンドの終了コードを 0 か 1 に丸めるので、自分で返す。
  if (process.platform === 'win32') {
    return ['pwsh', ['-NoProfile', '-Command', `${command}\n$ok = $?; if (-not $ok) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }`]];
  }
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
  // タブが閉じると画面へ書けなくなる。そこで落ちると止まった理由を残せない。
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  const write = (stream, chunk) => {
    stream.write(chunk);
    try {
      fs.writeSync(log, chunk);
    } catch {
      // ログを書けなくても、処理と exit.json は止めない。
    }
  };
  write(process.stdout, `[run-in-tab] ${startedAt.toISOString()} 開始\n[run-in-tab] cwd: ${job.cwd}\n[run-in-tab] $ ${job.command}\n`);

  const [shell, args] = shellFor(job.command);
  // 入力を待つコマンドが誰にも気づかれず止まり続けないよう、標準入力は渡さない。
  // 止めるときにシェルの子孫まで届くよう、プロセスグループを分ける（Windows には無い）。
  const ownGroup = process.platform !== 'win32';
  const child = spawn(shell, args, { cwd: job.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: ownGroup });
  const signalChild = (name) => {
    try {
      if (ownGroup) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      // 既に終わっていてもよい。
    }
  };
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
      signalChild(name);
      setTimeout(() => signalChild('SIGKILL'), INTERRUPT_GRACE_MS);
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
  return code ?? 128 + (os.constants.signals[signal] ?? 0);
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
  let paneCheckedAt = 0;
  let paneGoneAt = null;
  for (;;) {
    const result = readJson(exitFile(dir));
    if (result) {
      console.log(`--- ログの末尾 ${tailLines} 行 ---\n${tailOf(logFile(dir), tailLines)}\n---`);
      console.log(`${describe(result)}\nログ: ${logFile(dir)}`);
      closeTab(job.tab);
      return exitCode(result);
    }
    if (paneGoneAt === null && Date.now() - paneCheckedAt >= PANE_CHECK_MS) {
      paneCheckedAt = Date.now();
      if (paneIsGone(job.pane)) paneGoneAt = paneCheckedAt;
    }
    if (paneGoneAt !== null && Date.now() - paneGoneAt >= CLOSED_TAB_GRACE_MS) {
      console.log(`--- ログの末尾 ${tailLines} 行 ---\n${tailOf(logFile(dir), tailLines)}\n---`);
      console.log(`終わりを記録しないままタブが閉じられました。\nログ: ${logFile(dir)}`);
      return EXIT_NO_RECORD;
    }
    if (!fs.existsSync(logFile(dir)) && Date.now() - waitStarted > START_TIMEOUT_MS) {
      let screen = '';
      try {
        screen = herdr('pane', 'read', job.pane, '--lines', '20');
      } catch {
        // 画面を読めなくても、始まらなかったことは伝える。
      }
      console.log(`タブの中で処理が始まりませんでした。タブは残しています（${job.tab}）。\n${screen}`);
      return EXIT_NO_RECORD;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function readArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: Object.fromEntries(['label', 'cwd', 'dir', 'tail', 'attach', 'runner'].map((name) => [name, { type: 'string' }])),
  });
  const tail = Number(values.tail ?? DEFAULT_TAIL_LINES);
  if (!Number.isInteger(tail) || tail < 1) throw new Error(`--tail は1以上の整数で書く: ${values.tail}`);
  // 分けて渡すと、呼ぶ側のシェルで引用が外れ、タブのシェルで別のコマンドになる。
  if (positionals.length > 1) throw new Error("コマンドは引用で1つにまとめて渡す: -- '<コマンド>'");
  return { ...values, tail, command: positionals[0] };
}

function defaultDir(label) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const name = label.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40);
  const root = path.join(os.tmpdir(), 'run-in-tab');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, `${stamp}-${name}-`));
}

// タブ名の頭に付ける、どのセッションが作ったかの名前。Claude Code のセッションの名前（`<リポジトリ>-XX`）が無ければ、リポジトリの名前。
function ownerName(cwd) {
  const registry = readJson(path.join(os.homedir(), '.claude', 'sessions', `${process.env.CLAUDE_PID}.json`));
  if (registry?.name) return registry.name;
  try {
    // worktree でも元の clone の名前になるよう、共有の .git から引く。
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path.basename(path.dirname(common));
  } catch {
    return path.basename(cwd);
  }
}

function start({ command, label, cwd, dir }) {
  const name = label ?? command.trim().split(/\s+/).slice(0, 2).join(' ');
  const jobDir = dir ? path.resolve(dir) : defaultDir(name);
  fs.mkdirSync(jobDir, { recursive: true });
  // 前の回の exit.json を、今の回の結果として読まないため。
  if (fs.existsSync(jobFile(jobDir))) throw new Error(`前の回の結果がある置き場です: ${jobDir}`);
  const jobCwd = path.resolve(cwd ?? process.cwd());
  const workspace = process.env.HERDR_WORKSPACE_ID ? ['--workspace', process.env.HERDR_WORKSPACE_ID] : [];
  const tabName = `${ownerName(jobCwd)}: ${name}`;
  const created = JSON.parse(herdr('tab', 'create', ...workspace, '--cwd', jobCwd, '--label', tabName, '--no-focus')).result;
  const job = { command, cwd: jobCwd, label: tabName, pane: created.root_pane.pane_id, tab: created.tab.tab_id };
  fs.writeFileSync(jobFile(jobDir), JSON.stringify(job, null, 2));
  // 待つ側が打ち切られても待ち直せるよう、始めにここへ出す。
  console.log(`タブ: ${tabName}（${job.tab}）\n置き場: ${jobDir}`);
  // herdr は引数を空白でつなぐので、空白を含むパスは引用したまま1つの文字列で渡す。
  try {
    herdr('pane', 'run', job.pane, `node "${fileURLToPath(import.meta.url)}" --runner "${jobDir}"`);
  } catch (error) {
    closeTab(job.tab);
    fs.rmSync(jobFile(jobDir));
    throw error;
  }
  return jobDir;
}

async function main() {
  let options;
  try {
    options = readArgs(process.argv.slice(2));
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
    console.error("コマンドがありません: run-in-tab.mjs [--label <用途>] -- '<コマンド>'");
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
