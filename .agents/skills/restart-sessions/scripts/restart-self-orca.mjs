#!/usr/bin/env node
// restart-self.mjs の Orca 版。呼び出し元自身のセッションを、自分の端末を分割した新しい端末で立て直す。
// usage: restart-self.mjs [--allow-background] <資料の絶対パス>
//
// 進め方は Herdr 版（restart-self-herdr.mjs）と同じ。新セッションを先に立て、旧の端末を閉じるのは資料を読み終えた新セッションに任せる。
// 起動や読み込みが失敗すれば呼び出し元は生き残る。終了コードと SKIP・FAIL の決まりも同じ。
// Herdr 版との違い:
// - 名前は claude が付ける。新しいセッションは新しい名前になるので、名前の付け外しは無い（2つ目の引数は受けるが使わない）。
// - 分割した端末は起動のコマンドを持たせず、シェルに `claude` だけを打つ。起動のコマンドにすると、
//   Orca は窓を開き直すときに流し直し、claude が2つ動く（2026-11-21 に実際に起きた）。
//   分割した端末のシェルは、元の端末のシェルの場所でなく、Orca の作業フォルダーで始まる（実測）。`cd` を打つと、
//   シェルごとに書き方（`&&`・引用）が違って壊れうるので、claude の cwd が作業フォルダーと同じときだけ進める。

import { realpathSync } from 'node:fs';

import { handoffProblem } from './lib/handoff.mjs';
import { backgroundWorkHint, orca, orcaError, selfSession, submitAndConfirm, terminalInfo, waitForClaude, waitForShellPrompt } from './lib/orca.mjs';
import { paceNote } from './lib/pace.mjs';
import { attachGuide } from './lib/prompts.mjs';

const rawArgs = process.argv.slice(2);
const allowBackground = rawArgs.includes('--allow-background');
const [handoff] = rawArgs.filter((arg) => arg !== '--allow-background');
if (!handoff) {
  process.stderr.write('usage: restart-self.mjs [--allow-background] <資料の絶対パス>\n');
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

const found = selfSession();
const self = found?.handle ?? '';
const entry = found?.entry;
if (!self || !entry) skip('自分の端末か claude の登録（CLAUDE_PID の sessions/<pid>.json）を特定できない');
const sid = entry.sessionId;
// 時間がかかりうるので、照合の前に済ませる
const note = paceNote(self);

// 新セッションに旧の端末を閉じさせるので、claude 以外から呼ばれると無関係の端末を閉じさせることになる。
const terminal = terminalInfo(self);
if (terminal === null) skip(`自分の端末 ${self} を Orca から引けない（${orcaError()}）`);
if (terminal.agentIdentity !== 'claude') skip(`この端末で動いているのは claude ではない: ${terminal.agentIdentity ?? '不明'}`);

// 新しい端末は「このセッションと同じ場所」で起動する。別の場所で起動すると、CLAUDE.md も AGENTS.md も読まないセッションができる。
// 同じかは実体のパスで比べる（macOS の /tmp と /private/tmp のような別名で食い違わないため）。Windows のパスは大文字と小文字を区別しない。
// 作業フォルダーの下のフォルダーで起動した claude も、ここで止まる（cd を打つと、シェルごとに書き方が違って壊れうるため）。
const real = (path) => {
  try {
    const resolved = realpathSync.native(path);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch {
    return '';
  }
};
if (!entry.cwd || !real(entry.cwd) || real(entry.cwd) !== real(terminal.worktreePath ?? '')) {
  skip(
    `claude の cwd（${entry.cwd || '取れない'}）が Orca の作業フォルダー（${terminal.worktreePath ?? '取れない'}）と違う。分割した端末は作業フォルダーで始まるので、同じ場所で立て直せない。` +
      `手で立て直すなら、資料を書いてから /exit し、同じ端末のシェルで cwd に移って claude を起動し、@<資料> を渡す`,
  );
}

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

このセッション自身の再起動。前セッション（Orca の端末 ${self} / セッション ${sid}）は資料を書き終えて、閉じられるのを待っている。

1. この資料を読んで現状を把握する。
2. 把握できたら 'orca terminal close --terminal ${self}' で前セッションの端末を閉じる。閉じると前セッションは強制終了になる（資料は書けているので問題ない。戻りたくなったら 'claude --resume ${sid}'）。読み終える前に閉じないこと。
3. ユーザーに再起動の結果を報告し、下の「再起動した先の進め方」に従って引き継ぐ。

1 と 2 は確認を挟まずに進める。3 は、どれも（処理の立ち上げ直しも、作業の再開も、問いの出し直しや状態を聞く問いも）旧の端末を閉じてから行う。先に問いを出すと、答えを待つ間ずっと旧の端末が残る。`;
const { path: sent, error: guideProblem } = attachGuide(handoff, note, steps);
if (guideProblem) skip(guideProblem);

// 焦点は呼び出し元に残る（実測。分割しても active は元の端末のまま）。旧を閉じれば新が元の大きさに戻る。
const split = orca(['terminal', 'split', '--terminal', self]);
if (split === null) skip(`端末を分割できなかった（${orcaError()}）。何も変えていない`);
const created = split.split?.handle ?? '';
// orca が成功を返した以上、端末はできている。ハンドルが読めないだけ。ここで「何も変えていない」と言うと、再実行のたびに端末が増える。
if (!created) fail(`端末は分割できたがハンドルを読み取れない（Orca の出力の形が変わった可能性）。新しい端末が残っているので手で閉じること。出力: ${JSON.stringify(split).slice(0, 200)}`);
log(`新しい端末 ${created}`);

// --- ここから先は、失敗したら何が残ったかを必ず伝える ---

const closeCreated = () =>
  orca(['terminal', 'close', '--terminal', created]) !== null ? '新しい端末は閉じた。' : `新しい端末 ${created} が残っている（orca terminal close --terminal ${created} で閉じること）。`;

// シェルが上がるのを待ってから、貼り付けでなくそのまま打ち込む。
if (!waitForShellPrompt(created, 15)) {
  fail(`新しい端末 ${created} にシェルのプロンプトが出ない。${closeCreated()}旧セッションはそのまま`);
}
if (orca(['terminal', 'send', '--terminal', created, '--text', 'claude\r']) === null) {
  fail(`新しい端末のシェルに claude を打てなかった（${orcaError()}）。${closeCreated()}旧セッションはそのまま`);
}

// 起動に失敗しても新しい端末は閉じない。信頼ダイアログのように「ユーザーがその端末で答えれば進む」種類の失敗があり、
// 閉じると答えようとした画面が目の前で消える（Herdr 版と同じ。2026-09-12 に実際に起こしている）。
const started = waitForClaude(created, 60, entry.pid);
if (!started) {
  fail(
    `新しい端末 ${created} で claude が上がったのを確かめられない。開いたまま残した。信頼ダイアログや確認が出ていれば端末で答えること。` +
      `答えたら 'orca terminal close --terminal ${created}' で閉じてから、同じ引数で呼び直す。閉じずに呼び直すと端末が増える。旧セッションはそのまま`,
  );
}
log(`起動（${started.name ?? started.sessionId}）`);

const request = `@${sent} このセッション自身の再起動です。資料の先頭の「自己再起動の手順」に従うこと。`;
const submitted = submitAndConfirm(created, request);
if (submitted.result === 'refused') fail(`新セッションに依頼を送れなかった（${submitted.detail}）。${closeCreated()}旧セッションはそのまま`);
if (submitted.result === 'unknown') {
  fail(
    `新しい端末 ${created} の新セッションが資料を読み始めたのを確かめられない（${submitted.detail}）。呼び直さない（端末が増える）。` +
      `新しい端末を見て、ダイアログには答え、入力欄に依頼が残っていれば Enter を押す。claude が終わってシェルに戻っていれば 'orca terminal close --terminal ${created}' で閉じてから呼び直す。旧セッションはそのまま`,
  );
}
if (submitted.result === 'resent') log('依頼が入力欄に残っていたので、Enter を送り直した');

process.stdout.write(`OK\t${self}\t${created}\t${started.name ?? ''}\t${handoff}\tresume:${sid}\n`);
log('ここで止まる。報告は不要（この先の出力は読まれないまま消える）');
