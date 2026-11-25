#!/usr/bin/env node
// 仕事を終えた呼び出し元自身のセッションが、記録を残して自分の hc の端末を閉じる。
// usage: exit-self.mjs [--allow-background] <要約（最終報告の1行）>
//
// 終えてよい条件（終わらないとき）は exit-self.md。ここで確かめるのは機械的に分かること（hc の claude の端末か・hub でないか・モードラインに処理が出ていないか）だけ。
// 要約は ~/.claude/session-exits.log に1行で残す。相談役（hub）がこれを読んでユーザーに知らせる。
// /exit は送らない（終了の確認画面が出ることがある）。切り離したプロセスが 2 秒後に hc kill と hc rm をする。セッションIDは resume できる。
// 終了コード: 0 は閉じる手配を済ませた（この後は何も出力しない）。1 は SKIP（何も変えていない。理由を報告して続ける）。

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { closeSelfDetached, exitLogLine, isHubCwd, parseExitArgs } from './lib/exit.mjs';
import { backgroundWorkHint, cwdOf, hcError, isClaude, selfId, sessionOf, terminalInfo } from './lib/hc.mjs';

const skip = (message) => {
  process.stderr.write(`[exit-self] SKIP: ${message}\n`);
  process.exit(1);
};

const args = parseExitArgs(process.argv.slice(2));
if (!args) skip('usage: exit-self.mjs [--allow-background] <要約（最終報告の1行）>。要約は必須');

const self = selfId();
const info = self ? terminalInfo(self) : null;
if (!info) skip(`自分の端末（HC_TERMINAL_ID=${self || '空'}）を hc から引けない（${hcError()}）`);
if (!isClaude(info)) skip(`この端末で動いているのは claude ではない: ${info.foreground?.name ?? '不明'}`);
const cwd = cwdOf(info);
if (isHubCwd(cwd)) skip('相談役（hub）のセッションは自分で終わらない');
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

const logPath = path.join(homedir(), '.claude', 'session-exits.log');
const line = exitLogLine({ name: info.name || self, cwd, sid, summary: args.summary });
try {
  mkdirSync(path.dirname(logPath), { recursive: true });
  appendFileSync(logPath, line);
} catch (error) {
  skip(`終了の記録を ${logPath} に書けない（${error.message}）。記録が残らないので終わらない`);
}

const failure = { path: logPath, line: exitLogLine({ name: info.name || self, cwd, sid, summary: `CLOSE FAILED: 端末 ${self} を閉じられなかった（前の行の終了は済んでいない）` }) };
const pid = closeSelfDetached(self, new URL('./lib/hc.mjs', import.meta.url).href, { failure });
if (!pid) {
  appendFileSync(logPath, failure.line);
  skip(`端末を閉じるプロセスを起動できない。端末は閉じていない（記録には CLOSE FAILED を追記した）。終わらずに続ける`);
}
process.stdout.write(`OK\t${self}\t${info.name ?? ''}\tresume:${sid}\n`);
process.stderr.write(`[exit-self] 2秒後にこの端末 ${self} を閉じる。戻るなら 'claude --resume ${sid}'。ここで止まる（この先の出力は読まれない）\n`);
