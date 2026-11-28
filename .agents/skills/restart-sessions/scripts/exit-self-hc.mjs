#!/usr/bin/env node
// 仕事を終えた呼び出し元自身のセッションが、記録を残して自分の hc の端末を閉じる。
// usage: exit-self.mjs [--allow-background] <要約（最終報告の1行）>
//
// 終えてよい条件（終わらないとき）は exit-self.md。ここで確かめるのは機械的に分かること（hc の claude の端末か・hub でないか・モードラインに処理が出ていないか・会話ログの最後の SendMessage が届いたか）だけ。
// 要約は ~/.claude/session-exits.log に1行で残す。相談役（hub）がこれを読んでユーザーに知らせる。
// /exit は送らない（終了の確認画面が出ることがある）。切り離したプロセスが 2 秒後に hc kill と hc rm をする。セッションIDは resume できる。
// 終了コード: 0 は閉じる手配を済ませた（この後は何も出力しない）。1 は SKIP（何も変えていない。理由を報告して続ける）。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { loadConfig } from './lib/config.mjs';
import { reporter } from './lib/cli.mjs';
import { closeSelfDetached, exitLogLine, isHubCwd, parseExitArgs, sendMessageProblem } from './lib/exit.mjs';
import { backgroundWorkHint, cwdOf, hcError, isClaude, selfId, sessionOf, terminalInfo } from './lib/hc.mjs';

const { skip } = reporter('exit-self');

const args = parseExitArgs(process.argv.slice(2));
if (!args) skip('usage: exit-self.mjs [--allow-background] <要約（最終報告の1行）>。要約は必須');

const self = selfId();
const info = self ? terminalInfo(self) : null;
if (!info) skip(`自分の端末（HC_TERMINAL_ID=${self || '空'}）を hc から引けない（${hcError()}）`);
if (!isClaude(info)) skip(`この端末で動いているのは claude ではない: ${info.foreground?.name ?? '不明'}`);
const cwd = cwdOf(info);
const { config, error: configError } = loadConfig();
if (configError) skip(configError);
if (config.hubCwd !== undefined && (typeof config.hubCwd !== 'string' || !config.hubCwd.trim())) skip('config.local.json の hubCwd は空でないパスにすること');
if (isHubCwd(cwd, homedir(), config.hubCwd)) skip('相談役（hub）のセッションは自分で終わらない');
const sid = sessionOf(info);
if (!sid) skip(`自分の端末 ${self} のセッションIDを claude agents から引けない（${hcError() || '前景の pid に当たる項目が無い'}）。resume の手がかりが無いまま終わらない`);

if (!args.allowBackground) {
  const hint = backgroundWorkHint(self);
  if (hint) {
    skip(
      `自分のモードラインに「${hint}」と出ている。端末を閉じると一緒に止まる。TaskStop で止めて消えたのを確かめてから呼び直す。` +
        `--allow-background は、端末を閉じても動き続けると確かめた独立したプロセスにだけ使う`,
    );
  }
}

// 会話ログは ~/.claude/projects/*/<セッションID>.jsonl（extract-transcript.mjs と同じ探し方）。見つからなければ確かめずに進む（これまでと同じ）。
const transcript = findTranscript(sid);
if (transcript) {
  let lines = null;
  try {
    lines = readFileSync(transcript, 'utf8').split('\n');
  } catch {
    // 読めなければ、見つからないときと同じく確かめずに進む。
  }
  const problem = lines && sendMessageProblem(lines, args.summary);
  if (problem) skip(problem);
}

const logPath = path.join(homedir(), '.claude', 'session-exits.log');
const line = exitLogLine({ name: info.name || self, cwd, sid, summary: args.summary });
try {
  mkdirSync(path.dirname(logPath), { recursive: true });
  appendFileSync(logPath, line);
} catch (error) {
  skip(`終了の記録を ${logPath} に書けない（${error.message}）。記録が残らないので終わらない`);
}

const failure = { path: logPath, line: exitLogLine({ name: info.name || self, cwd, sid, summary: `CLOSE FAILED: 端末 ${self} が閉じたことを確かめられなかった（前の行の終了は済んでいないかもしれない）` }) };
const pid = closeSelfDetached(self, new URL('./lib/hc.mjs', import.meta.url).href, { failure });
if (!pid) {
  let note = '記録には CLOSE FAILED を追記した';
  try {
    appendFileSync(logPath, failure.line);
  } catch (error) {
    note = `記録への CLOSE FAILED の追記も失敗した（${error.message}）。${logPath} の最後の行は終わったと読めるので、手で直す`;
  }
  skip(`端末を閉じるプロセスを起動できない。端末は閉じていない（${note}）。終わらずに続ける`);
}
process.stdout.write(`OK\t${self}\t${info.name ?? ''}\tresume:${sid}\n`);
process.stderr.write(`[exit-self] 2秒後にこの端末 ${self} を閉じる。戻るなら 'claude --resume ${sid}'。ここで止まる（この先の出力は読まれない）\n`);

function findTranscript(sessionId) {
  const projectsDir = path.join(homedir(), '.claude', 'projects');
  try {
    return (
      readdirSync(projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(projectsDir, entry.name, `${sessionId}.jsonl`))
        .find((file) => existsSync(file)) ?? null
    );
  } catch {
    return null;
  }
}
