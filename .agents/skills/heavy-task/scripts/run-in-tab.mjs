#!/usr/bin/env node
// コマンドを hc・Herdr・Orca の別の端末（タブ）で流し、出力・終了コード・止まった理由をファイルに残す。
// hc の端末（HC_TERMINAL_ID がある）なら hc の新しい端末、Herdr の中（HERDR_ENV=1）なら Herdr のタブ、
// Orca の端末（ORCA_TERMINAL_HANDLE がある）なら、同じ作業フォルダーに作る Orca の端末のタブ。
//
//   node run-in-tab.mjs [--label <用途>] [--cwd <場所>] [--dir <置き場>] [--tail <行数>] [--expect <分>] -- '<コマンド>'
//   node run-in-tab.mjs --attach <置き場> [--expect <分>]    待つ側だけが終わったときに、待ち直す
//
// --expect を過ぎても終わらなければ、タブの処理は止めずに、待つ側だけが EXIT_OVERRUN で返る。
// バックグラウンドで待つエージェントは、待つ側が終わったときにしか起きないので、処理が詰まったまま眠り続けないための目覚まし。
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
// Windows でタブが閉じると、子はこのコードで終わる。SIGHUP はその後に届き、exit.json を書くのに間に合わない。Ctrl+C では SIGINT が先に届く。
const STATUS_CONTROL_C_EXIT = 0xc000013a;
const DEFAULT_TAIL_LINES = 40;
const TAIL_BYTES = 256 * 1024;
// 止める知らせを無視する処理は、この後で強制終了する。
const INTERRUPT_GRACE_MS = 5000;
const PANE_CHECK_MS = 5000;
// タブが閉じると、タブの側はこの間に exit.json を書く。INTERRUPT_GRACE_MS と OUTPUT_DRAIN_MS の和より長くする。
const CLOSED_TAB_GRACE_MS = 10_000;
// 記録の無いまま終わったとき。コマンドの終了コードと区別できるよう、文でも伝える。
const EXIT_NO_RECORD = 125;
// 見込みを過ぎても終わらないとき。timeout(1) と同じ値で、処理の失敗でなく待つのをやめたことを表す。
const EXIT_OVERRUN = 124;

const herdr = (...args) => execFileSync('herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// Orca の CLI は --json で { ok, result } を返し、失敗も JSON で stdout に出す。失敗は code を載せて投げる。
// restart-sessions の scripts/lib/orca.mjs と同じ読み方を、ここにも持つ。skill は1つずつ置かれ、heavy-task だけを置いた所でも動かすため
// （読み方を変えるときは両方を直す）。
function orca(...args) {
  let out;
  try {
    out = execFileSync('orca', [...args, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    out = String(error.stdout ?? '');
    if (!out.trim()) throw error;
  }
  const data = JSON.parse(out);
  if (data.ok !== true) throw Object.assign(new Error(`orca ${args.slice(0, 2).join(' ')}: ${data.error?.message ?? out.trim()}`), { code: data.error?.code });
  return data.result;
}
// hc の失敗は stderr に {"error":{"kind"}} で出る。kind を載せて投げる（restart-sessions の scripts/lib/hc.mjs と同じ読み方。変えるときは両方を直す）。
// core が応えないときに待つ側が止まり続けないよう、15秒で打ち切る（ふだんは1回が数十ミリ秒）。終了コードが 0 なら、出力が JSON でなくても成功とみなす。
// CLAUDE*・HERDR_* は外して呼ぶ。core が動いていなければ hc がその場で core を起動し、core はその環境をどの端末にも引き継ぐため
// （claude の中から起動すると、そこで起動した claude が会話の記録を書かない。restart-sessions の scripts/lib/hc.mjs の hcEnv と同じ）。
const hcEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|HERDR_)/.test(key)));
function hc(...args) {
  let out;
  try {
    out = execFileSync('hc', [args[0], '--json', ...args.slice(1)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, env: hcEnv() });
  } catch (error) {
    let kind;
    try {
      kind = JSON.parse(String(error.stderr ?? '')).error?.kind;
    } catch {
      // JSON でなければ kind は無い。
    }
    throw Object.assign(new Error(`hc ${args[0]}: ${String(error.stderr || error.message).trim()}`), { kind });
  }
  try {
    return JSON.parse(out) ?? {};
  } catch {
    return {};
  }
}
// hc を一番先に見る。hc の端末は core を起動した環境の HERDR_ENV=1 を引き継ぐことがある。Herdr と Orca の両方の中にいれば Herdr を先にする
// （restart-sessions の scripts/lib/mux.mjs と同じ見分け方）。
const inHc = () => Boolean(process.env.HC_TERMINAL_ID);
const inHerdr = () => !inHc() && process.env.HERDR_ENV === '1';
const inOrca = () => !inHc() && !inHerdr() && Boolean(process.env.ORCA_TERMINAL_HANDLE);
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
  // Orca の端末では、同じ置き場で2回目を流さない。打ち込んだ行がシェルの履歴に残り、タブで ↑ と Enter を押すと、同じ処理（push など）を繰り返すため。
  // Herdr のタブは分ける前のまま（置き場を使い回したときに続けて流す）。
  if (job.terminal && fs.existsSync(logFile(dir))) {
    console.error(`この置き場の処理は一度流れています: ${dir}`);
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
    if (code === STATUS_CONTROL_C_EXIT) interruptedBy ??= 'SIGHUP';
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
      signalChild(name);
      // 続けて届いても、最初の理由を残し、強制終了の時刻を延ばさない。
      if (interruptedBy) return;
      interruptedBy = name;
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

function exitCode({ code, signal, interruptedBy }) {
  // 3221225786 をそのまま返すと 58 に丸められ、普通の失敗に見える。
  if (code === STATUS_CONTROL_C_EXIT) return 128 + os.constants.signals[interruptedBy];
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

// job.hc があれば hc の端末、job.terminal があれば Orca の端末、どちらも無ければ Herdr のペインとタブ。待ち直し（--attach）でも、始めた側の道具で見る。
function paneIsGone(job) {
  if (job.hc) {
    try {
      // hc の端末のプログラムは runner そのものなので、終わった（finished）なら、もう exit.json は書かれない。
      return hc('get', job.hc).state !== 'live';
    } catch (error) {
      // core に一時的につながらないだけなら、消えたとみなさない。
      return error.kind === 'not_found';
    }
  }
  if (job.terminal) {
    try {
      // 閉じた端末は、しばらく show が通り続け、connected が false になる（実測）。
      const terminal = orca('terminal', 'show', '--terminal', job.terminal).terminal;
      return terminal?.connected === false || terminal?.orphaned === true;
    } catch (error) {
      // サーバーに一時的につながらないだけなら、消えたとみなさない。
      return error.code === 'terminal_handle_stale';
    }
  }
  try {
    herdr('pane', 'get', job.pane);
    return false;
  } catch (error) {
    // サーバーに一時的につながらないだけなら、消えたとみなさない。
    return String(error.stdout).includes('pane_not_found') || String(error.stderr).includes('pane_not_found');
  }
}

function closeTab(job) {
  try {
    if (job.hc) {
      // rm は終わった端末しか外せない（生きていれば kind live で断る）ので、先に kill する。kill は終わるまで待って返す（実測）が、
      // kill が失敗しても（既に外された・一時的につながらない）rm は試し、まだ生きていれば少し待つ。
      try {
        hc('kill', job.hc);
      } catch {
        // 下の rm で片付く場合がある。
      }
      for (let i = 0; i < 10; i += 1) {
        try {
          if (hc('get', job.hc).state !== 'live') break;
        } catch {
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      }
      hc('rm', job.hc);
    } else if (job.terminal) orca('terminal', 'close', '--terminal', job.terminal, '--tab');
    else herdr('tab', 'close', job.tab);
  } catch {
    // 既に閉じられていてもよい。
  }
}

function readTabScreen(job) {
  if (job.hc) return hc('read', job.hc).text.split('\n').slice(-20).join('\n');
  if (!job.terminal) return herdr('pane', 'read', job.pane, '--lines', '20');
  return (orca('terminal', 'read', '--terminal', job.terminal, '--screen').terminal?.tail ?? []).slice(-20).join('\n');
}

const screenCommand = (job) =>
  job.hc ? `hc read ${job.hc}` : job.terminal ? `orca terminal read --terminal ${job.terminal} --screen` : `herdr pane read ${job.pane} --lines 20`;

function overrunReport(dir, job, minutes, tailLines) {
  let grown = '';
  try {
    const seconds = Math.round((Date.now() - fs.statSync(logFile(dir)).mtimeMs) / 1000);
    grown = `ログが最後に増えたのは ${seconds} 秒前。\n`;
  } catch {
    // ログがまだ無くても、見込みを過ぎたことは伝える。
  }
  console.log(`--- ログの末尾 ${tailLines} 行 ---\n${tailOf(logFile(dir), tailLines)}\n---`);
  console.log(
    `見込みの ${minutes} 分を過ぎても終わっていません。タブは動いたままです（${job.label}、${job.hc ?? job.terminal ?? job.tab}）。\n${grown}` +
      `ログ: ${logFile(dir)}\n画面: ${screenCommand(job)}\n進んでいるかを確かめ、待ち直すなら --attach ${dir} --expect <分>、止めるならタブを閉じる。`,
  );
  return EXIT_OVERRUN;
}

async function waitFor(dir, tailLines, expectMinutes) {
  const job = readJson(jobFile(dir));
  if (!job) {
    console.error(`job.json を読めません: ${dir}`);
    return 2;
  }
  const waitStarted = Date.now();
  const deadline = expectMinutes === undefined ? Infinity : waitStarted + expectMinutes * 60_000;
  let paneCheckedAt = 0;
  let paneGoneAt = null;
  for (;;) {
    // 終わりの記録を読む前に時刻を見る。読んだ後に見ると、その間に終わった処理まで見込み超えにしてしまう。
    const overdue = Date.now() >= deadline;
    const result = readJson(exitFile(dir));
    if (result) {
      console.log(`--- ログの末尾 ${tailLines} 行 ---\n${tailOf(logFile(dir), tailLines)}\n---`);
      console.log(`${describe(result)}\nログ: ${logFile(dir)}`);
      closeTab(job);
      return exitCode(result);
    }
    if (paneGoneAt === null && Date.now() - paneCheckedAt >= PANE_CHECK_MS) {
      paneCheckedAt = Date.now();
      if (paneIsGone(job)) paneGoneAt = paneCheckedAt;
    }
    if (paneGoneAt !== null && Date.now() - paneGoneAt >= CLOSED_TAB_GRACE_MS) {
      console.log(`--- ログの末尾 ${tailLines} 行 ---\n${tailOf(logFile(dir), tailLines)}\n---`);
      console.log(`終わりを記録しないままタブが閉じられました。\nログ: ${logFile(dir)}`);
      return EXIT_NO_RECORD;
    }
    if (!fs.existsSync(logFile(dir)) && Date.now() - waitStarted > START_TIMEOUT_MS) {
      let screen = '';
      try {
        screen = readTabScreen(job);
      } catch {
        // 画面を読めなくても、始まらなかったことは伝える。
      }
      console.log(`タブの中で処理が始まりませんでした。タブは残しています（${job.hc ?? job.terminal ?? job.tab}）。\n${screen}`);
      return EXIT_NO_RECORD;
    }
    if (overdue) return overrunReport(dir, job, expectMinutes, tailLines);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function readArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: Object.fromEntries(['label', 'cwd', 'dir', 'tail', 'attach', 'runner', 'expect'].map((name) => [name, { type: 'string' }])),
  });
  const tail = Number(values.tail ?? DEFAULT_TAIL_LINES);
  if (!Number.isInteger(tail) || tail < 1) throw new Error(`--tail は1以上の整数で書く: ${values.tail}`);
  const expect = values.expect === undefined ? undefined : Number(values.expect);
  if (expect !== undefined && !(expect > 0)) throw new Error(`--expect は0より大きい分で書く: ${values.expect}`);
  // 分けて渡すと、呼ぶ側のシェルで引用が外れ、タブのシェルで別のコマンドになる。
  if (positionals.length > 1) throw new Error("コマンドは引用で1つにまとめて渡す: -- '<コマンド>'");
  return { ...values, tail, expect, command: positionals[0] };
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
  const tabName = `${ownerName(jobCwd)}: ${name}`;
  const runCommand = `node "${fileURLToPath(import.meta.url)}" --runner "${jobDir}"`;
  if (inHc()) return startInHc(jobDir, { command, cwd: jobCwd, label: tabName });
  if (inOrca()) return startInOrca(jobDir, { command, cwd: jobCwd, label: tabName }, runCommand);
  const workspace = process.env.HERDR_WORKSPACE_ID ? ['--workspace', process.env.HERDR_WORKSPACE_ID] : [];
  const created = JSON.parse(herdr('tab', 'create', ...workspace, '--cwd', jobCwd, '--label', tabName, '--no-focus')).result;
  const job = { command, cwd: jobCwd, label: tabName, pane: created.root_pane.pane_id, tab: created.tab.tab_id };
  fs.writeFileSync(jobFile(jobDir), JSON.stringify(job, null, 2));
  // 待つ側が打ち切られても待ち直せるよう、始めにここへ出す。
  console.log(`タブ: ${tabName}（${job.tab}）\n置き場: ${jobDir}`);
  // herdr は引数を空白でつなぐので、空白を含むパスは引用したまま1つの文字列で渡す。
  try {
    herdr('pane', 'run', job.pane, runCommand);
  } catch (error) {
    closeTab(job);
    fs.rmSync(jobFile(jobDir));
    throw error;
  }
  return jobDir;
}

// 呼び出し元と同じ作業フォルダー（ORCA_WORKTREE_ID。無ければ Orca で開いているもの）に端末のタブを作り、シェルに打ち込んで流す。
// 起動のコマンド（--command）にしないのは、Orca が窓を開き直すときに起動のコマンドを流し直すため（2026-11-21 に claude で実際に起きた）。
// 打ち込むのは貼り付けでなくそのままの文字で、Enter は CR で送る。
// タブは焦点を奪わずに開く（--focus を付けなければ切り替えない。orca terminal create --help と、作った後も前のタブが選ばれたままだったのを実測）。
function startInOrca(jobDir, base, runCommand) {
  const worktree = process.env.ORCA_WORKTREE_ID ? `id:${process.env.ORCA_WORKTREE_ID}` : 'active';
  const created = orca('terminal', 'create', '--worktree', worktree, '--title', base.label).terminal;
  // ハンドルが無いまま進むと、後の処理が Herdr の側に倒れ、作ったタブが閉じられずに残る。
  if (!created?.handle) throw new Error(`orca terminal create の出力にハンドルが無い（Orca の出力の形が変わった可能性）。「${base.label}」のタブが残っていれば閉じること`);
  const job = { ...base, terminal: created.handle };
  fs.writeFileSync(jobFile(jobDir), JSON.stringify(job, null, 2));
  console.log(`タブ: ${base.label}（${job.terminal}）\n置き場: ${jobDir}`);
  try {
    // 作ったばかりの端末へ打つ。シェルが上がる前に打った文字も、端末が預かってシェルに読ませる（続けて5つ作って打ち、どれも流れたのを実測）。
    orca('terminal', 'send', '--terminal', job.terminal, '--text', `${runCommand}\r`);
  } catch (error) {
    closeTab(job);
    fs.rmSync(jobFile(jobDir));
    throw error;
  }
  return jobDir;
}

// hc の新しい端末で、runner を端末のプログラムとして流す（シェルを挟まないので、引用もシェルの履歴も絡まない）。
// - 名前は hc の規則（a-z 0-9 - _ を32字まで）に合わせたタブ名。生きた端末の間で一意なので、使われていれば -2, -3 … を付ける。
// - --outlive-parent: 呼び出し元の端末の子にはなるが、呼び出し元（claude）が終わっても止めない。Herdr のタブと同じく、立て直しの間も処理を続けるため。
// - --no-notify: 終わりの知らせを呼び出し元の入力に打ち込ませない。終わりは待つ側（waitFor）が読んで返す。
// タブ名そのものはラベル run_in_tab に残す（名前にすると日本語などが落ちるため）。
const HC_NAME_TRIES = 20;

function hcName(label) {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '') || 'run-in-tab';
  return (n) => (n === 1 ? slug.slice(0, 32) : `${slug.slice(0, 32 - String(n).length - 1).replace(/-+$/, '')}-${n}`).replace(/-+$/, '');
}

function startInHc(jobDir, base) {
  const nameOf = hcName(base.label);
  const argv = [process.execPath, fileURLToPath(import.meta.url), '--runner', jobDir];
  let created;
  for (let n = 1; !created; n += 1) {
    try {
      created = hc('run', '--bg', '--outlive-parent', '--no-notify', '--cwd', base.cwd, '--name', nameOf(n), '--label', `run_in_tab=${base.label}`, '--', ...argv);
    } catch (error) {
      if (error.kind !== 'name_taken' || n >= HC_NAME_TRIES) throw error;
    }
  }
  // address が無いまま進むと、後の処理が Herdr の側に倒れ、作った端末が閉じられずに残る。
  if (!created?.address) throw new Error(`hc run の出力に address が無い（hc の出力の形が変わった可能性）。「${nameOf(1)}」の端末が残っていれば閉じること`);
  const job = { ...base, hc: created.address, name: created.name ?? '' };
  fs.writeFileSync(jobFile(jobDir), JSON.stringify(job, null, 2));
  console.log(`タブ: ${base.label}（hc の端末 ${job.hc}${job.name ? `、${job.name}` : ''}）\n置き場: ${jobDir}`);
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
  if (!inHc() && !inHerdr() && !inOrca()) {
    console.error('hc の端末でも、Herdr の中でも Orca の端末でもないので、タブで流せません（HC_TERMINAL_ID が無く、HERDR_ENV=1 でも ORCA_TERMINAL_HANDLE でもない）。');
    return 2;
  }
  if (options.attach) return waitFor(options.attach, options.tail, options.expect);
  if (!options.command?.trim()) {
    console.error("コマンドがありません: run-in-tab.mjs [--label <用途>] -- '<コマンド>'");
    return 2;
  }
  return waitFor(start(options), options.tail, options.expect);
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
