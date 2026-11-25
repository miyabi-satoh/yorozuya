// 自分の仕事が済んだセッションが、自分の端末を閉じて終わるための部品（exit-self-hc.mjs が使う）。
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// 引数は `[--allow-background] <要約>`。要約（最終報告の1行）が空なら null。
export function parseExitArgs(args) {
  const allowBackground = args.includes('--allow-background');
  const summary = args
    .filter((arg) => arg !== '--allow-background')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return summary ? { allowBackground, summary } : null;
}

// 相談役（hub）の cwd か。hub は自分で終わらない。シンボリックリンクを解いて比べる。
export function isHubCwd(cwd, home = homedir()) {
  if (!cwd) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const hub = real(path.join(home, 'Projects', 'hub'));
  const target = real(cwd);
  return target === hub || target.startsWith(`${hub}${path.sep}`);
}

// 終了の記録の1行（TSV）。列: ISO 時刻・端末名・cwd・セッションID・要約。タブと改行は空白にする。
export function exitLogLine({ time = new Date(), name, cwd, sid, summary }) {
  const clean = (text) => String(text ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  return `${time.toISOString()}\t${clean(name)}\t${clean(cwd)}\t${clean(sid)}\t${clean(summary)}\n`;
}

// 自分の端末を、自分から切り離したプロセスに閉じさせる。端末を kill すると自分も終わるので、
// 新しいセッション（setsid）・stdio なし・unref の別プロセスに、少し待ってから kill と rm をさせる。
// /exit を送らないので、終了の確認画面が出ない。
// 閉じたことを確かめられなければ（hc が端末をまだ返す・読み込みや hc の呼び出しが落ちた）、別プロセスが failure（記録のファイルと1行）を追記する。
// 先に書いた「終わった」の行だけが残り、端末が生きたままなのに終わったと読まれないようにするため。起動できなければ null（呼び出し側が止まる）。
export function closeSelfDetached(id, hcModuleUrl, { delaySeconds = 2, failure } = {}) {
  const onFail = failure ? `(await import('node:fs')).appendFileSync(${JSON.stringify(failure.path)}, ${JSON.stringify(failure.line)});` : '';
  const code =
    `let closed = false; try { const m = await import(${JSON.stringify(hcModuleUrl)}); m.sleep(${Number(delaySeconds)}); ` +
    `m.closeTerminal(${JSON.stringify(id)}); closed = m.terminalInfo(${JSON.stringify(id)}) === null; } catch {} ` +
    `if (!closed) { ${onFail} }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  // 起動に失敗すると pid が無く、'error' が後から出る。受けないとこのプロセスが落ちるので、受けて捨てる（失敗は pid で返す）。
  child.on('error', () => {});
  if (!child.pid) return null;
  child.unref();
  return child.pid;
}
