#!/usr/bin/env node
// restart.mjs の hc 版。対象の端末の claude を終了させ、同じ cwd の新しい hc の端末で起動し直して引き継ぎ資料を読ませる。
// usage: restart.mjs [--allow-background] <端末の address> <名前> <資料の絶対パス>
//   名前は端末の名前（hc ls の name）。名前の無い端末なら address をもう一度渡す。取り違えの照合に使う。
//
// Herdr 版（restart-herdr.mjs）と同じく、/exit から資料を渡すまでを1つのプロセスで走り切る。終了コードと SKIP・FAIL の決まりも同じ。
// Herdr 版との違い:
// - 起動し直すのは新しい端末（claude を起動のコマンドにし、依頼は claude の引数で渡す。lib/hc.mjs の startClaude）。
//   claude が端末のプログラムそのものなら、/exit で端末が終わるので、外して（hc rm）名前を空けてから同じ名前で作る。
//   シェルから起動した claude なら、終わった後の端末はシェルに戻るので、そのまま残す（シェルに残ったものを失わないため）。
//   そのときは名前が空かないので、lib/hc.mjs の successorName の名前にする。
// - 新しい端末は呼び出し元の子にしない（--no-parent）。子にすると、呼び出し元が終わったときに一緒に終わる。

import { handoffProblem } from './lib/handoff.mjs';
import {
  backgroundWorkHint,
  cwdOf,
  hc,
  hcError,
  hcErrorKind,
  inputDraft,
  isClaude,
  liveNames,
  markRestarting,
  prompt,
  selfId,
  SEND_REFUSED,
  sessionIdOf,
  sleep,
  startClaude,
  statusOf,
  successorName,
  terminalInfo,
  waitForStart,
} from './lib/hc.mjs';
import { paceNote } from './lib/pace.mjs';
import { attachGuide, HOW_TO_PROCEED } from './lib/prompts.mjs';

const rawArgs = process.argv.slice(2);
const allowBackground = rawArgs.includes('--allow-background');
const [target, name, handoff] = rawArgs.filter((arg) => arg !== '--allow-background');
if (!target || !name || !handoff) {
  process.stderr.write('usage: restart.mjs [--allow-background] <端末の address> <名前> <資料の絶対パス>\n');
  process.exit(1);
}

const log = (message) => process.stderr.write(`[${name}] ${message}\n`);
// 旧の端末に restarting を付けている間は true。旧が残ったまま止まるときは外す（残すと、後で旧が終わっても rencon がタイルを閉じず、来ない新しい端末を待ち続ける）。
let restarting = false;
const clearRestarting = () => {
  if (!restarting) return;
  // 一時の失敗で残らないよう、1秒おきに3回まで試す。外せたときだけ下ろす（シェルに戻った道で外せなければ、後の SKIP・FAIL でもう一度試す）。
  for (let i = 0; i < 3 && restarting; i += 1) {
    if (i > 0) sleep(1);
    if (markRestarting(target, false)) restarting = false;
  }
  if (restarting) log(`端末 ${target} のラベル restarting を外せなかった（${hcError()}）。'hc label ${target} restarting=' で外すこと`);
};
const skip = (message) => {
  clearRestarting();
  process.stderr.write(`[${name}] SKIP: ${message}\n`);
  process.exit(1);
};
const fail = (message) => {
  clearRestarting();
  process.stderr.write(`[${name}] FAIL: ${message}\n`);
  process.exit(1);
};

// --- /exit を送る前に、確かめられることは全部ここで確かめる ---

const problem = handoffProblem(handoff, '対象の端末');
if (problem) skip(problem);
if (target === selfId()) skip('対象は自分の端末。自分の再起動は restart-self.mjs で行う');
// 時間がかかりうるので、対象の状態を確かめる前に済ませる
const note = paceNote();

// 引数の取り違えで無関係のセッションを終了させないよう、中身を照合する。
const info = terminalInfo(target);
if (info === null) skip(`端末 ${target} を引けない（${hcError()}）。'hc ls' で address を引き直すこと`);
// get は名前でも引けるが、名前は終わった端末から外れて別の端末に付きうる。address で渡されたものだけを受ける。
if (info.address !== target) skip(`${target} は address ではない（${info.address} に解決された）。第1引数は address で渡すこと`);
if (!isClaude(info)) skip(`端末 ${target} で動いているのは claude ではない: ${info.foreground?.name ?? info.state ?? '不明'}`);
if ((info.name || info.address) !== name) skip(`端末 ${target} の名前は ${info.name || '（無し）'} で、渡された ${name} と違う。address か名前を引き直すこと`);
if (statusOf(info) === 'blocked') skip(`端末 ${target} は承認・質問ダイアログで止まっている。ユーザーに端末で答えてもらってから呼ぶこと`);

// 旧セッションID は、途中で止まっても claude --resume で戻れるよう先に控える。控えられないなら終了させない。
const sid = sessionIdOf(info);
if (!sid) skip(`端末 ${target} にラベル claude_transcript が無く、セッションIDを引けない。resume の手がかりが無いまま終了させたくないので止まる`);
const cwd = cwdOf(info);
if (!cwd) skip(`端末 ${target} の cwd を hc から取れない。新しい端末をどこで起動するか決められないので止まる`);

if (!allowBackground) {
  const hint = backgroundWorkHint(target);
  if (hint) {
    skip(
      `端末 ${target} のモードラインに「${hint}」と出ている。対象の自己申告と食い違っていないか確かめること。` +
        `対象に TaskStop で止めてもらい、モードラインから消えたのを確かめて同じ引数で呼び直す。` +
        `--allow-background は、対象がセッションを終えても動かし続けたいと明言した独立したプロセスにだけ使う`,
    );
  }
}

const { path: sent, error: guideProblem } = attachGuide(handoff, note);
if (guideProblem) skip(guideProblem);

// --- ここから後戻りできない ---

// 案内に載せるコマンドの引数。シェルに貼っても $ や ` が展開されないよう、POSIX のシングルクォートで包む（中の ' は '\'' にする）。
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const request = `@${sent} 前セッションの引き継ぎ資料です。${HOW_TO_PROCEED}`;
const recovery =
  `新しいセッションで続けるなら、「hc run --bg --no-parent --cwd ${shellQuote(cwd)} claude」で起動し、上がったら '@${sent}' を打つ。` +
  `元の会話に戻るなら 'claude --resume ${sid}'`;

// 入力欄に書きかけがあれば送らない。/exit が書きかけの末尾につながり、書きかけごと送信される（Herdr 版と同じ）。
const draft = inputDraft(target);
if (draft === null) skip(`端末 ${target} の入力欄を読めない（${hcError() || '枠が見つからない'}）。書きかけがあるかもしれないので止まる。端末を見ること`);
if (draft) {
  skip(`端末 ${target} の入力欄に書きかけがある（「${draft.replace(/\s+/g, ' ').slice(0, 40)}」）。ユーザーが打っている最中かもしれないので止まる。送信されるか消えてから呼び直す`);
}

log(`旧セッション ${sid}（止まったまま残ったら、claude --resume ${sid} で元の会話に戻れる）`);
log('終了');
restarting = markRestarting(target);
if (!restarting) log(`端末 ${target} にラベル restarting を付けられなかった（${hcError()}）。rencon のタイルは移らずに閉じる`);
if (!prompt(target, '/exit')) {
  const error = hcError();
  if (SEND_REFUSED.has(hcErrorKind())) skip(`/exit を送れなかった（${error}）。対象はそのまま動いている`);
  fail(`/exit の送信が失敗した（${error || '理由不明'}）。対象が終了したまま起動されていないかもしれない。'hc read ${target}' で見ること。claude が動いていれば、入力欄に /exit が残っていないか確かめて消す。終わっていれば、${recovery}`);
}

// 終わったかは、端末が終わったか（claude が端末のプログラム）、前景が claude でなくなったか（シェルに戻った）で見る。
let after = null;
for (let i = 0; i < 60; i += 1) {
  sleep(1);
  const now = terminalInfo(target);
  if (now && !isClaude(now)) {
    after = now;
    break;
  }
  if (now && statusOf(now) === 'blocked') {
    fail(`/exit の後に確認画面が出ている。端末で答えてもらうこと。キャンセルして claude が動き続けているなら何も変わっていないので、同じ引数で呼び直せる。終了したら、${recovery}`);
  }
}
if (!after) fail(`60秒たっても claude が終わらない。'hc read ${target}' で見ること。終了していたら、${recovery}`);

// 端末ごと終わったなら外して名前を空ける。シェルに戻った端末は残す。
let newName = info.name ?? '';
if (after.state === 'finished') {
  // 旧はもう終わっているので、この後に止まっても印は外さない（rencon は新しい端末を待つ）。
  restarting = false;
  if (hc(['rm', target]) === null) log(`終わった端末 ${target} を外せなかった（${hcError()}）。名前が空かなければ別の名前で作る`);
} else {
  clearRestarting();
  log(`元の端末 ${target} はシェルに戻ったので残す。用が済んでいれば 'hc kill ${target}' と 'hc rm ${target}' で閉じること`);
}
const taken = liveNames();
const wanted = newName;
if (newName && taken !== null) newName = successorName(newName, taken);
if (wanted && !newName) log(`名前 ${wanted} とその代わりの名前がどれも使われているので、名前を付けずに起動する`);

log('起動');
const created = startClaude({ cwd, name: newName, request, replaces: info.address });
if (!created) fail(`新しい端末で claude を起動できなかった（${hcError()}）。${recovery}`);
log(`新しい端末 ${created}${newName ? `（${newName}）` : ''}`);
const started = waitForStart(created);
if (started.result === 'exited') fail(`新しい端末 ${created} の claude がすぐに終わった（'hc read ${created}' で理由を見る）。${recovery}`);
if (started.result === 'blocked') fail(`新しい端末 ${created} がダイアログで止まっている。端末で答えてもらえば、資料を読み始める`);
if (started.result !== 'started') {
  fail(`起動はしたが資料を読み始めたのを確かめられない。'hc read ${created}' で見て、入力欄に依頼が残っていれば 'hc keys ${created} enter'、空なら @${sent} と打つ`);
}

process.stdout.write(`OK\t${created}\t${newName || created}\t${handoff}\tresume:${sid}\n`);
