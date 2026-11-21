#!/usr/bin/env node
// restart.mjs の Orca 版。対象の端末の claude を終了させ、同じ作業フォルダーに作り直した端末で起動し直して引き継ぎ資料を読ませる。
// usage: restart.mjs [--allow-background] <端末のハンドル> <名前> <資料の絶対パス>
//   名前は端末のタイトルから状態の印を外したもの（`clipkeep-2c/mac` など。lib/orca.mjs の stripTitle）。取り違えの照合に使う。
//
// Herdr 版（restart-herdr.mjs）と同じく、/exit から資料を渡すまでを1つのプロセスで走り切る。終了コードと SKIP・FAIL の決まりも同じ。
// Herdr 版との違い:
// - claude が動いたことのある端末には打ち込まない。終わった後の画面がシェルに戻ったかを見分ける決め手が無く
//   （画面からの見分けは、ステータスラインの形などで外れる）、別の何かへ打ち込むおそれがあるため。
//   claude の pid が消えたら、同じ作業フォルダーに同じタイトルの端末を作り、その新しい端末に `claude` を打ってから、元の端末を閉じる。
//   タブの位置は変わる。作ったばかりの端末へ打った文字は、シェルが上がる前でも端末が預かって読ませる（実測）。
// - 起動のコマンド（--command）にはしない。Orca は窓を開き直すときに起動のコマンドを流し直し、同じ会話の claude が2つ動く（2026-11-21 に実際に起きた）。
// - 名前は Orca でなく claude が付ける。新しいセッションは新しい名前になるので、名前の付け外しは無い。
// - 終わったかは、登録簿にある claude のプロセスが消えたかで見る。Orca の agentIdentity は claude が終わっても残る（実測）。

import { handoffProblem } from './lib/handoff.mjs';
import {
  agentList,
  agentState,
  agentStateOf,
  backgroundWorkHint,
  inputDraft,
  liveSessions,
  pidAlive,
  orca,
  orcaError,
  orcaErrorCode,
  prompt,
  sameDir,
  SEND_REFUSED,
  sessionForTitle,
  sessionsForTitle,
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

// 新しい端末は同じ作業フォルダーに作り、作業フォルダーで始まる（実測）。作業フォルダーが分からないか、claude の cwd が
// 作業フォルダーと違えば（下のフォルダーで起動したなど）、同じ場所で起動し直せないので、/exit の前に止まる。
if (!terminal.worktreeId || !terminal.worktreePath) skip(`端末 ${handle} の作業フォルダーを Orca から取れない。新しい端末をどこに作るか決められないので止まる`);
if (!sameDir(entry.cwd, terminal.worktreePath)) {
  skip(
    `claude の cwd（${entry.cwd || '取れない'}）が Orca の作業フォルダー（${terminal.worktreePath}）と違う。作り直す端末は作業フォルダーで始まるので、同じ場所で起動し直せない。` +
      `手で再起動するなら、対象に /exit してもらい、同じ端末のシェルで claude を起動して @<資料> を渡す`,
  );
}
// 作り直す端末のタイトル。claude が動いている間のタイトルは claude の名前なので、タブに付いた名前（paneTitle）を先にし、
// 無ければ状態の印を外した今のタイトルにする。
const newTitle = (typeof terminal.paneTitle === 'string' && terminal.paneTitle.trim()) || stripTitle(terminal.title);

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

const recovery = `新しいセッションで続けるなら、端末を見て、シェルに戻っていれば 'claude' を打ち、起動したら '@${sent}' を打つ。元の会話に戻るなら、端末で 'claude --resume ${sid}'`;

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
  // 終わったかは pid が消えたかで見る（claude かの見分けに頼ると、見分け損ねたときに動いている claude を終わったと読む）。
  // 消えないまま（同じ pid が使い回された・/exit がターンの後ろに並んだ）なら、時間切れで止まり、何も打たない。
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
if (!back) fail(`60秒たっても claude のプロセスが消えない。何も打っていない。端末を見ること。終了してシェルに戻っていたら、${recovery}`);

// 元の端末に後から出たものを見分ける目印。claude の終わりの表示とプロンプトが出きるのを少し待ってから、流れた出力の位置を控える。
// 控えられなければ、元の端末は閉じない（後で何かが始まっていても見分けられないため）。
sleep(2);
const mark = orca(['terminal', 'read', '--terminal', handle])?.terminal?.nextCursor ?? null;

log('起動');
const tabTitle = newTitle || stripTitle(terminalInfo(handle)?.title);
const created = orca(['terminal', 'create', '--worktree', `id:${terminal.worktreeId}`, ...(tabTitle ? ['--title', tabTitle] : [])])?.terminal?.handle ?? '';
if (!created) fail(`新しい端末を作れなかった（${orcaError() || 'ハンドルが無い'}）。元の端末 ${handle} は残っている。${recovery}`);
log(`新しい端末 ${created}`);
const recoveryNew = `新しい端末 ${created} を見て、claude が上がっていれば（ダイアログには答えてから）'@${sent}' を打つ。元の会話に戻るなら 'claude --resume ${sid}'`;
// 貼り付けでなく、そのまま打ち込む。
if (orca(['terminal', 'send', '--terminal', created, '--text', 'claude\r']) === null) {
  fail(`新しい端末に claude を打てなかった（${orcaError()}）。元の端末 ${handle} も残っている。${recoveryNew}`);
}
const started = waitForClaude(created, 60, entry.pid);
if (!started) fail(`新しい端末で claude の起動を確かめられない。元の端末 ${handle} も残している。${recoveryNew}`);

const submitted = submitAndConfirm(created, `@${sent} 前セッションの引き継ぎ資料です。${HOW_TO_PROCEED}`);
if (submitted.result === 'refused' || submitted.result === 'unknown') {
  fail(`起動はしたが資料を読み始めたのを確かめられない（${submitted.detail}）。新しい端末 ${created} を見て、入力欄に依頼が残っていれば Enter を押し、空なら @${sent} と打つ`);
}
if (submitted.result === 'resent') log('依頼が入力欄に残っていたので、Enter を送り直した');

// 新しいセッションが資料を受け取ってから、claude が終わって空いた元の端末を閉じる。先に閉じると、新しい側が上がらなかったときに、
// 元の端末に残っていたもの（シェルの処理や、/exit の後に打たれた文）まで失う。
// 待っている間に元の端末で何かが始まっていれば（ユーザーかほかのエージェントが打った）閉じない。控えた位置より後に文のある出力が無く、
// タイトルに当たる生きた claude も1つも無いときだけ閉じる。読めない・見分けられないときも閉じない。閉じなくても、新しい端末で続けられる。
const since = mark === null ? null : orca(['terminal', 'read', '--terminal', handle, '--cursor', String(mark)])?.terminal;
const quiet = Array.isArray(since?.tail) && since.tail.every((line) => line.trim() === '');
const now = terminalInfo(handle);
const claudesThere = now ? sessionsForTitle(liveSessions(), now.title) : null;
if (!quiet || claudesThere === null || claudesThere.length > 0) {
  log(`元の端末 ${handle} は、後から何かが動いたか確かめられないので閉じない。用が済んでいれば 'orca terminal close --terminal ${handle}' で閉じること`);
} else if (orca(['terminal', 'close', '--terminal', handle]) === null) {
  log(`元の端末 ${handle} を閉じられなかった（${orcaError()}）。'orca terminal close --terminal ${handle}' で閉じること`);
}

process.stdout.write(`OK\t${created}\t${name}\t${handoff}\tresume:${sid}\tnew:${started.name ?? ''}\n`);
