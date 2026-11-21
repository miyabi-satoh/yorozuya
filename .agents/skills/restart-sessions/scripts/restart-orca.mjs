#!/usr/bin/env node
// restart.mjs の Orca 版。対象の端末の claude を終了させ、同じ端末のシェルで起動し直して引き継ぎ資料を読ませる。
// usage: restart.mjs [--allow-background] <端末のハンドル> <名前> <資料の絶対パス>
//   名前は端末のタイトルから状態の印を外したもの（`clipkeep-2c/mac` など。lib/orca.mjs の stripTitle）。取り違えの照合に使う。
//
// Herdr 版（restart-herdr.mjs）と同じく、/exit から資料を渡すまでを1つのプロセスで走り切る。終了コードと SKIP・FAIL の決まりも同じ。
// Herdr 版との違い:
// - 新しい端末を作らず、claude が終わって残ったシェルに `claude` を打つ。端末の起動のコマンドにすると、
//   Orca は窓を開き直すときに起動のコマンドを流し直し、同じ会話の claude が2つ動く（2026-11-21 に実際に起きた）。
// - 名前は Orca でなく claude が付ける。新しいセッションは新しい名前になるので、名前の付け外しは無い。
// - シェルに戻ったかは、登録簿にある claude のプロセスが消えたかで見る。Orca の agentIdentity は claude が終わっても残る（実測）。

import { handoffProblem } from './lib/handoff.mjs';
import {
  agentList,
  agentState,
  agentStateOf,
  backgroundWorkHint,
  inputDraft,
  liveSessions,
  orca,
  orcaError,
  orcaErrorCode,
  pidAlive,
  prompt,
  SEND_REFUSED,
  sessionForTitle,
  sleep,
  stripTitle,
  submitAndConfirm,
  terminalInfo,
  waitForClaude,
} from './lib/orca.mjs';
import { paceNote } from './lib/pace.mjs';
import { attachGuide, HOW_TO_PROCEED } from './lib/prompts.mjs';

const rawArgs = process.argv.slice(2);
const allowBackground = rawArgs.includes('--allow-background');
const [handle, name, handoff] = rawArgs.filter((arg) => arg !== '--allow-background');
if (!handle || !name || !handoff) {
  process.stderr.write('usage: restart.mjs [--allow-background] <端末のハンドル> <名前> <資料の絶対パス>\n');
  process.exit(1);
}

const log = (message) => process.stderr.write(`[${name}] ${message}\n`);
const skip = (message) => {
  process.stderr.write(`[${name}] SKIP: ${message}\n`);
  process.exit(1);
};
const fail = (message) => {
  process.stderr.write(`[${name}] FAIL: ${message}\n`);
  process.exit(1);
};

// --- /exit を送る前に、確かめられることは全部ここで確かめる ---

const problem = handoffProblem(handoff, '対象の端末');
if (problem) skip(problem);
if (handle === process.env.ORCA_TERMINAL_HANDLE) skip('対象は自分の端末。自分の再起動は restart-self.mjs で行う');
// 時間がかかりうるので、対象の状態を確かめる前に済ませる
const note = paceNote();

// 引数の取り違えで無関係のセッションを終了させないよう、端末・タイトル・登録簿を照合する。
const terminal = terminalInfo(handle);
if (terminal === null) skip(`端末 ${handle} を引けない（${orcaError()}）。'orca terminal list --json' でハンドルを引き直すこと`);
if (terminal.connected === false) skip(`端末 ${handle} はもう閉じている`);
if (terminal.agentIdentity !== 'claude') skip(`端末 ${handle} で動いているのは claude ではない: ${terminal.agentIdentity ?? '不明'}`);
const title = stripTitle(terminal.title);
if (title !== name) skip(`端末 ${handle} のタイトルは ${title || '（空）'} で、渡された ${name} と違う。ハンドルか名前を引き直すこと`);

// 旧セッションID は、途中で止まっても claude --resume で戻れるよう先に控える。控えられないなら終了させない。
const entry = sessionForTitle(liveSessions(), terminal.title, terminal.worktreePath);
if (!entry) skip(`端末 ${handle} の claude を登録簿から1つに決められない。resume の手がかりが無いまま終了させたくないので止まる`);
const sid = entry.sessionId;

// 承認・質問ダイアログで止まっている相手には、打ち込んでも届かない。
if (agentStateOf(agentList(), terminal) === 'blocked') {
  skip(`端末 ${handle} は承認・質問ダイアログで止まっている。ユーザーに端末で答えてもらってから呼ぶこと`);
}

// 対象の自己申告と実際の追跡が食い違うことがあるので、/exit の前にモードラインで照合する（Herdr 版と同じ）。
if (!allowBackground) {
  const hint = backgroundWorkHint(handle);
  if (hint) {
    skip(
      `端末 ${handle} のモードラインに「${hint}」と出ている。対象の自己申告と食い違っていないか確かめること。` +
        `対象に TaskStop で止めてもらい、モードラインから消えたのを確かめて同じ引数で呼び直す。` +
        `--allow-background は、対象がセッションを終えても動かし続けたいと明言した独立したプロセスにだけ使う`,
    );
  }
}

const { path: sent, error: guideProblem } = attachGuide(handoff, note);
if (guideProblem) skip(guideProblem);

// --- ここから後戻りできない ---

const recovery = `新しいセッションで続けるなら、端末のシェルで 'claude' を打ち、起動したら '@${sent}' を打つ。元の会話に戻るなら、端末で 'claude --resume ${sid}'`;

// 入力欄に書きかけがあれば送らない。/exit が書きかけの末尾につながり、書きかけごと送信される（Herdr 版と同じ）。
const draft = inputDraft(handle);
if (draft === null) skip(`端末 ${handle} の入力欄を読めない（${orcaError() || '枠が見つからない'}）。書きかけがあるかもしれないので止まる。端末を見ること`);
if (draft) {
  skip(`端末 ${handle} の入力欄に書きかけがある（「${draft.replace(/\s+/g, ' ').slice(0, 40)}」）。ユーザーが打っている最中かもしれないので止まる。送信されるか消えてから呼び直す`);
}

log(`旧セッション ${sid}（/exit の後にシェルに戻ったまま止まっていたら、端末で claude --resume ${sid} を打てば元の会話に戻れる）`);
log('終了');
if (!prompt(handle, '/exit')) {
  const error = orcaError();
  if (SEND_REFUSED.has(orcaErrorCode())) skip(`/exit を送れなかった（${error}）。対象はそのまま動いている`);
  fail(
    `/exit の送信が失敗した（${error || '理由不明'}）。対象が終了したまま起動されていないかもしれない。端末を見ること。claude が動いていれば、入力欄に /exit が残っていないか確かめて消す。シェルに戻っていれば、${recovery}`,
  );
}

let back = false;
for (let i = 0; i < 60; i += 1) {
  sleep(1);
  if (!pidAlive(entry.pid)) {
    back = true;
    break;
  }
  if (agentState(handle) === 'blocked') {
    fail(
      `/exit の後に確認画面が出ている。端末で答えてもらうこと。キャンセルして claude が動き続けているなら何も変わっていないので、同じ引数で呼び直せる。終了してシェルに戻ったら、${recovery}`,
    );
  }
}
if (!back) fail(`シェルに戻らない。端末を見ること。終了してシェルに戻っていたら、${recovery}`);

log('起動');
// シェルへは貼り付けでなく、そのまま打ち込む（--enter を付けると、claude と見なしたままの端末へは貼り付けで送られる）。
if (orca(['terminal', 'send', '--terminal', handle, '--text', 'claude\r']) === null) {
  fail(`シェルに claude を打てなかった（${orcaError()}）。${recovery}`);
}
const started = waitForClaude(handle, 60, entry.pid);
if (!started) {
  fail(
    `起動を確かめられない。端末を見ること。確認やダイアログ（フォルダーの信頼など）が出ていれば答え、claude が上がっていれば '@${sent}' を打つ。シェルのままなら、${recovery}`,
  );
}

const submitted = submitAndConfirm(handle, `@${sent} 前セッションの引き継ぎ資料です。${HOW_TO_PROCEED}`);
if (submitted.result === 'refused' || submitted.result === 'unknown') {
  fail(`起動はしたが資料を読み始めたのを確かめられない（${submitted.detail}）。端末を見て、入力欄に依頼が残っていれば Enter を押し、空なら @${sent} と打つ`);
}
if (submitted.result === 'resent') log('依頼が入力欄に残っていたので、Enter を送り直した');

process.stdout.write(`OK\t${handle}\t${name}\t${handoff}\tresume:${sid}\tnew:${started.name ?? ''}\n`);
