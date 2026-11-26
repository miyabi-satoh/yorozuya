#!/usr/bin/env node
// restart-self.mjs の hc 版。呼び出し元自身のセッションを、hc の新しい端末で立て直す。
// usage: restart-self.mjs [--allow-background] <資料の絶対パス> [name]
//
// 進め方は Herdr 版（restart-self-herdr.mjs）と同じ。新セッションを先に立て、旧の端末を閉じるのは資料を読み終えた新セッションに任せる。
// 起動や読み込みが失敗すれば呼び出し元は生き残る。終了コードと SKIP・FAIL の決まりも同じ。
// Herdr 版との違い:
// - hc は端末を分割しない。同じ cwd に新しい端末を作り、claude を起動のコマンドにして、依頼を claude の引数で渡す
//   （起動したばかりの claude に送った文は落ちることがあると hc の文書にある）。
// - hc は端末の名前を付け替えられず、名前は生きた端末の間で一意なので、旧の端末が生きている間は同じ名前を使えない。
//   新しい端末の名前は lib/hc.mjs の successorName（`<名前>` と `<名前>-2` を行き来する）。2つ目の引数で渡せばその名前にする。
// - 新しい端末は呼び出し元の子にしない（--no-parent）。子にすると、新セッションが旧の端末を閉じたときに自分も終わる。

import { basename, isAbsolute } from 'node:path';

import { reporter, takeFlag } from './lib/cli.mjs';
import { handoffProblem } from './lib/handoff.mjs';
import {
  backgroundWorkHint,
  claudeFlagsOf,
  cwdOf,
  hcError,
  isClaude,
  liveNames,
  lastStartNote,
  NAME_PATTERN,
  selfId,
  sessionOf,
  slugName,
  startClaude,
  successorName,
  terminalInfo,
  waitForStart,
} from './lib/hc.mjs';
import { paceNote } from './lib/pace.mjs';
import { attachGuide, selfRestartRequest, selfRestartSteps } from './lib/prompts.mjs';

const { on: allowBackground, rest } = takeFlag(process.argv.slice(2), '--allow-background');
const [handoff, nameArg] = rest;
if (!handoff) {
  process.stderr.write('usage: restart-self.mjs [--allow-background] <資料の絶対パス> [name]\n');
  process.exit(1);
}

const { log, skip, fail } = reporter('restart-self');

// --- 何かを変える前に、確かめられることは全部ここで確かめる ---

const problem = handoffProblem(handoff, '新セッション');
if (problem) skip(problem);

const self = selfId();
const info = self ? terminalInfo(self) : null;
if (!info) skip(`自分の端末（HC_TERMINAL_ID=${self || '空'}）を hc から引けない（${hcError()}）`);
// セッションIDは、資料が渡らなかったときに戻る手がかり。引けなければ止める。
const sid = sessionOf(info);
if (!sid) skip(`自分の端末 ${self} のセッションIDを claude agents から引けない（${hcError() || '前景の pid に当たる項目が無い'}）`);
// 時間がかかりうるので、照合の前に済ませる
const note = paceNote(self);

// 新セッションに旧の端末を閉じさせるので、claude 以外から呼ばれると無関係の端末を閉じさせることになる。
if (!isClaude(info)) skip(`この端末で動いているのは claude ではない: ${info.foreground?.name ?? '不明'}`);

// 新しい端末は「このセッションと同じ場所」で起動する。別の場所で起動すると、CLAUDE.md も AGENTS.md も読まないセッションができる。
const cwd = cwdOf(info);
if (!isAbsolute(cwd)) skip('端末の cwd を hc から取れない。新しい端末をどこで起動するか決められないので止まる');

// 呼び出し元への依頼は名前で届くので、名前はできるだけ保つ（行き来する2つの名前のどちらか）。
const taken = liveNames();
if (taken === null) skip(`hc の端末の一覧を取得できない（${hcError()}）`);
const base = info.name || slugName(basename(cwd));
// 代わりの名前がどれも使われていれば ''（名前を付けずに起動する）。
const name = nameArg ?? successorName(base, taken);
if (name && !NAME_PATTERN.test(name)) skip(`hc の名前の規則（英小文字・数字と _ - のみ・32字以内）に合わない: ${name}。2つ目の引数で名前を渡すこと`);
if (name && taken.has(name)) skip(`名前 ${name} はほかの端末が使用中。別の名前を2つ目の引数で渡すこと`);

// 自分の申告は記憶違いで実際の追跡と食い違いうるので、旧の端末を道連れにする前にモードラインで照合する（Herdr 版と同じ）。
if (!allowBackground) {
  const hint = backgroundWorkHint(self);
  if (hint) {
    skip(
      `自分のモードラインに「${hint}」と出ている。Monitor を TaskStop で止め、走らせ直すコマンドを資料に書いたか確かめること。` +
        `--allow-background は、端末を閉じても動き続けると確かめた独立したプロセスにだけ使う（Monitor やシェルは端末と一緒に止まる）`,
    );
  }
}

const steps = selfRestartSteps({
  where: `hc の端末 ${self}`,
  sid,
  close: `'hc kill ${self}' のあと 'hc rm ${self}' で前セッションの端末を閉じる`,
  old: '旧の端末',
});
const { path: sent, error: guideProblem } = attachGuide(handoff, note, steps);
if (guideProblem) skip(guideProblem);

const request = selfRestartRequest(sent);
// 起動の --model・--effort は旧の端末から引き継ぐ（/model で後から変えた分は引き継げない）。
const flags = claudeFlagsOf(info);
if (flags.length) log(`旧の端末の起動の引数を引き継ぐ: ${flags.join(' ')}`);
const created = startClaude({ cwd, name, request, replaces: info.address, flags });
if (lastStartNote()) log(lastStartNote());
if (!created) skip(`新しい端末で claude を起動できなかった（${hcError()}）。何も変えていない`);
log(`新しい端末 ${created}${name ? `（${name}）` : ''}`);

// --- ここから先は、失敗したら何が残ったかを必ず伝える ---

// 起動に失敗しても新しい端末は閉じない。信頼ダイアログのように「ユーザーがその端末で答えれば進む」種類の失敗があり、
// 閉じると答えようとした画面が目の前で消える（Herdr 版と同じ。2026-09-12 に実際に起こしている）。
const started = waitForStart(created);
if (started.result === 'exited') {
  fail(`新しい端末 ${created} の claude がすぐに終わった（終了コード ${started.info?.exit_code ?? '不明'}）。'hc read ${created}' で理由を見て、'hc rm ${created}' で外してから呼び直す。旧セッションはそのまま`);
}
if (started.result === 'blocked') {
  fail(
    `新しい端末 ${created} がダイアログで止まっている。端末で答えれば資料を読み始め、読み終えたら旧の端末を閉じる。呼び直さない（端末が増える）。` +
      `やめるなら 'hc kill ${created}' と 'hc rm ${created}' で閉じる。旧セッションはそのまま`,
  );
}
if (started.result !== 'started') {
  fail(
    `新しい端末 ${created} の新セッションが資料を読み始めたのを確かめられない（${hcError() || '60秒たっても動き出さない'}）。呼び直さない（端末が増える）。` +
      `'hc read ${created}' で画面を見て、ダイアログには答え、入力欄に依頼が残っていれば Enter を押す（'hc keys ${created} enter'）。claude が終わっていれば 'hc rm ${created}' で外してから呼び直す。旧セッションはそのまま`,
  );
}

process.stdout.write(`OK\t${self}\t${created}\t${name}\t${handoff}\tresume:${sid}\n`);
log('ここで止まる。報告は不要（この先の出力は読まれないまま消える）');
