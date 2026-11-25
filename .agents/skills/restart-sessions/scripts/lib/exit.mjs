// 自分の仕事が済んだセッションが、自分の端末を閉じて終わるための部品（exit-self-hc.mjs が使う）。
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { takeFlag } from './cli.mjs';

// 引数は `[--allow-background] <要約>`。要約（最終報告の1行）が空なら null。
export function parseExitArgs(args) {
  const { on: allowBackground, rest } = takeFlag(args, '--allow-background');
  const summary = rest
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
// 閉じたことを確かめられなければ（hc が端末をまだ返す・hc が not_found 以外のエラーを返す・読み込みが落ちた）、別プロセスが failure（記録のファイルと1行）を追記する。
// 先に書いた「終わった」の行だけが残り、端末が生きたままなのに終わったと読まれないようにするため。起動できなければ null（呼び出し側が止まる）。
export function closeSelfDetached(id, hcModuleUrl, { delaySeconds = 2, failure } = {}) {
  const onFail = failure ? `(await import('node:fs')).appendFileSync(${JSON.stringify(failure.path)}, ${JSON.stringify(failure.line)});` : '';
  const code =
    `let closed = false; try { const m = await import(${JSON.stringify(hcModuleUrl)}); m.sleep(${Number(delaySeconds)}); ` +
    `m.closeTerminal(${JSON.stringify(id)}); closed = m.terminalInfo(${JSON.stringify(id)}) === null && m.hcErrorKind() === 'not_found'; } catch {} ` +
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

// 会話ログ（JSONL の行）の最後の SendMessage が、終わってよい形で済んでいるか。済んでいれば null、だめなら理由。
// 報告を SendMessage で返して終わるセッションが、送れなかったことを読まずに終わらないようにする（exit-self.md「ほかのセッションへ報告を返すとき」）。
// 止まる側にだけ倒す: 結果の形が読めないときは済んだものとして扱い、はっきり読めた失敗と未着だけを理由にする。
// 届かない（送り直せない）と分かって終わるときは、要約に「返信は未達」と書けば通す。前の失敗や打ち切った手番で終われなくならないため。
export function sendMessageProblem(lines, summary = '') {
  const uses = new Map();
  let last = null;
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    // 会話の行だけを見る。api-request-blob などの行は同じ tool_use を写して持つ。
    if (record?.type !== 'assistant' && record?.type !== 'user') continue;
    if (record.isSidechain) continue;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && block.name === 'SendMessage' && !uses.has(block.id)) {
        last = block.id;
        uses.set(block.id, { to: block.input?.to, result: undefined });
      } else if (block?.type === 'tool_result' && uses.has(block.tool_use_id)) {
        Object.assign(uses.get(block.tool_use_id), { result: toolResultText(block.content), isError: block.is_error === true });
      }
    }
  }
  if (!last) return null;
  if (summary.includes('返信は未達')) return null;
  const { to, result, isError } = uses.get(last);
  if (result === undefined) {
    return `最後の SendMessage（宛先 ${to}）の結果がまだ会話ログに無い。同じ手番に並べず、結果を読んでから次の手番で呼び直す（手番を打ち切って結果が残らなかったなら、要約に「返信は未達」と書いて呼び直す）`;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(result);
  } catch {
    // JSON でない結果は形が読めないので通す。エラーと印の付いたものだけは失敗として扱う。
  }
  const brief = (text) => String(text ?? '').replace(/\s+/g, ' ').slice(0, 200);
  if (isError || parsed?.success === false) {
    return `最後の SendMessage（宛先 ${to}）が届いていない（${brief(parsed?.message ?? result)}）。結果の文面が言う形で送り直してから呼び直す。送り直せないなら、要約に「返信は未達」と理由を書いて呼び直す`;
  }
  // 結果の文面は「“題” → 宛先 (届け方)」の形で送った題を引用するので、題の語に当たらないよう、最後の → より後ろを見る（2.1.332 で実測した文面）。
  const message = String(parsed?.message ?? '');
  if (/queued|offline/i.test(message.slice(message.lastIndexOf('→') + 1))) {
    return `最後の SendMessage（宛先 ${to}）は相手がオフラインで queued のまま。要約に「返信は未達のおそれ（queued）」と書いて呼び直す`;
  }
  return null;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  return '';
}
