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

import { handoffProblem } from './lib/handoff.mjs';
import {
  backgroundWorkHint,
  cwdOf,
  hcError,
  isClaude,
  liveNames,
  NAME_PATTERN,
  selfId,
  sessionIdOf,
  slugName,
  startClaude,
  successorName,
  terminalInfo,
  waitForStart,
} from './lib/hc.mjs';
import { paceNote } from './lib/pace.mjs';
import { attachGuide } from './lib/prompts.mjs';

const rawArgs = process.argv.slice(2);
const allowBackground = rawArgs.includes('--allow-background');
const [handoff, nameArg] = rawArgs.filter((arg) => arg !== '--allow-background');
if (!handoff) {
  process.stderr.write('usage: restart-self.mjs [--allow-background] <資料の絶対パス> [name]\n');
  process.exit(1);
}

const log = (message) => process.stderr.write(`[restart-self] ${message}\n`);
const skip = (message) => {
  process.stderr.write(`[restart-self] SKIP: ${message}\n`);
  process.exit(1);
};
const fail = (message) => {
  process.stderr.write(`[restart-self] FAIL: ${message}\n`);
  process.exit(1);
};

// --- 何かを変える前に、確かめられることは全部ここで確かめる ---

const problem = handoffProblem(handoff, '新セッション');
if (problem) skip(problem);

const self = selfId();
const info = self ? terminalInfo(self) : null;
if (!info) skip(`自分の端末（HC_TERMINAL_ID=${self || '空'}）を hc から引けない（${hcError()}）`);
// セッションIDは、資料が渡らなかったときに戻る手がかり。引けなければ止める。
const sid = sessionIdOf(info);
if (!sid) skip(`自分の端末 ${self} にラベル claude_transcript が無く、セッションIDを特定できない。claude の SessionStart の hook（hc-transcript-label）が入っているか確かめること`);
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

const steps = `# 自己再起動の手順

このセッション自身の再起動。前セッション（hc の端末 ${self} / セッション ${sid}）は資料を書き終えて、閉じられるのを待っている。

1. この資料を読んで現状を把握する。
2. 把握できたら 'hc kill ${self}' のあと 'hc rm ${self}' で前セッションの端末を閉じる。閉じると前セッションは強制終了になる（資料は書けているので問題ない。戻りたくなったら 'claude --resume ${sid}'）。読み終える前に閉じないこと。
3. ユーザーに再起動の結果を報告し、下の「再起動した先の進め方」に従って引き継ぐ。

1 と 2 は確認を挟まずに進める。3 は、どれも（処理の立ち上げ直しも、作業の再開も、問いの出し直しや状態を聞く問いも）旧の端末を閉じてから行う。先に問いを出すと、答えを待つ間ずっと旧の端末が残る。`;
const { path: sent, error: guideProblem } = attachGuide(handoff, note, steps);
if (guideProblem) skip(guideProblem);

const request = `@${sent} このセッション自身の再起動です。資料の先頭の「自己再起動の手順」に従うこと。`;
const created = startClaude({ cwd, name, request, replaces: info.address });
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
