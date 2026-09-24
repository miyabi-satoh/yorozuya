#!/usr/bin/env node
// 対象のペインの claude を終了させ、起動し直して引き継ぎ資料を読ませる。
// usage: restart.mjs [--allow-background] <pane_id> <name> <資料の絶対パス>
//
// この4手は1つのプロセスで走り切る。/exit と起動の間で中断されると、対象は
// セッションの無いペインとして取り残される。呼び出し側がターンをまたぐと起こりうる。
//
// 終了コード: 0 成功 / 1 失敗。失敗は2種類あり、stderr の接頭辞で見分ける。
//   SKIP — /exit を送る前に止まった。対象は無傷。
//   FAIL — 送った後に止まった。復旧の道筋をメッセージに書く。
//
// --allow-background を付けないとき、モードラインにバックグラウンドのシェル・Monitor が
// 見えていれば SKIP する（対象の自己申告と実際の追跡が食い違うことがあるため）。
// 対象に止めてもらってから呼び直す。--allow-background は、対象がセッションを終えても動かし続けたいと明言した独立したプロセスにだけ使う。

import { handoffProblem } from './lib/handoff.mjs';
import { HOW_TO_PROCEED } from './lib/prompts.mjs';
import {
  agentInfo,
  agentStatus,
  backgroundWorkHint,
  herdrError,
  herdrErrorCode,
  NAME_PATTERN,
  paneHoldingName,
  prompt,
  SEND_REFUSED,
  shellIsBack,
  sleep,
  startAgent,
  waitForNameRelease,
} from './lib/herdr.mjs';

const rawArgs = process.argv.slice(2);
const allowBackground = rawArgs.includes('--allow-background');
const [pane, name, handoff] = rawArgs.filter((arg) => arg !== '--allow-background');
if (!pane || !name || !handoff) {
  process.stderr.write('usage: restart.mjs [--allow-background] <pane_id> <name> <資料の絶対パス>\n');
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

const problem = handoffProblem(handoff, '対象のペイン');
if (problem) skip(problem);
if (!NAME_PATTERN.test(name)) skip(`Herdr の名前の規則（先頭は小文字・英数と _ - のみ・32字以内）に合わない: ${name}`);

// 引数の取り違え（別のペインのIDを渡す）で無関係のセッションを終了させないよう、中身を照合する。
// 閉じたペインのIDは使い回されず、別ワークスペースへ移ったペインは新しいIDになる（Herdr の文書）。
// なので古いIDは not found で弾かれ、照合から /exit までの間に別のペインにすり替わることは無い。
const info = agentInfo(pane);
if (info === null) skip(`ペイン ${pane} のエージェントを引けない（${herdrError()}）。ペインIDを引き直すこと`);

// agent get は Herdr 名でも解決する。名前を pane の引数に渡されても、この時点では通ってしまう。
// だが後続の pane process-info はペインIDしか受け付けないので、/exit を送った後に必ず行き詰まる。
// 引き当てた pane_id と渡された文字列が一致することを、ここで確かめる。
if (info.pane_id !== pane) {
  skip(`${pane} はペインIDではない（${info.pane_id} に解決された）。第1引数はペインIDで渡すこと`);
}
if (info.agent !== 'claude') skip(`ペイン ${pane} で動いているのは claude ではない: ${info.agent ?? '不明'}`);

// 承認・質問ダイアログで止まっている相手には agent prompt が届かない。
// 先に見て止めれば、生のエラー JSON ではなく何が起きているかを伝えられる。
if (info.agent_status === 'blocked') {
  skip(`ペイン ${pane} は承認・質問ダイアログで止まっている。ユーザーにペインで答えてもらってから呼ぶこと`);
}
if (info.name && info.name !== name) {
  skip(`ペイン ${pane} の Herdr 名は ${info.name} で、渡された ${name} と違う。ペインIDか名前を引き直すこと`);
}

// Herdr 名を持たない claude ペインは普通にある。上の名前の照合はその場合に何も言わないので、
// 名前の側からも確かめる。他のペインが握っていれば起動の段で必ず失敗する ―― /exit の前に気づく。
const holder = paneHoldingName(name);
if (holder === null) skip(`Herdr のエージェント一覧を取得できない（${herdrError()}）`);
if (holder && holder !== pane) {
  skip(`名前 ${name} は ${holder} が握っている。ペインIDか名前を引き直すこと`);
}

// 旧セッションID は、途中で止まっても claude --resume で戻れるよう先に控える。
// 控えられないなら終了させない。戻る手がかりが無い状態で殺すことになる。
const sid = info.agent_session?.value ?? '';
if (!sid) skip(`ペイン ${pane} のセッションIDを引けない。resume の手がかりが無いまま終了させたくないので止まる`);

// 対象の自己申告（「バックグラウンド処理はありません」）は、実際にハーネスが追跡している
// シェル・Monitor と食い違うことがある（2026-09-11・2026-09-23 に別プロジェクトで実際に発生）。
// モードラインは対象の記憶に頼らない表示なので、/exit の前にここで機械的に照合する。
if (!allowBackground) {
  const hint = backgroundWorkHint(pane);
  if (hint) {
    skip(
      `ペイン ${pane} のモードラインに「${hint}」と出ている。対象の自己申告と食い違っていないか確かめること。` +
        `対象に TaskStop で止めてもらい、モードラインから消えたのを確かめて同じ引数で呼び直す。` +
          `--allow-background は、対象がセッションを終えても動かし続けたいと明言した独立したプロセスにだけ使う`,
    );
  }
}

// --- ここから後戻りできない ---

// /exit を送った後に止まったときの戻り方。
// 「同じ引数で再実行」は成り立たない。シェルに戻ったペインにはエージェントがいないので
// agent get が agent_not_found を返し、pre-flight で SKIP になる。手で起動し直す道を示す。
// シェルに戻っても名前はすぐには外れないので、外れたのを確かめてから起動させる。
const recovery =
  `新しいセッションで続けるなら、'herdr agent list' で名前 ${name} が消えたのを確かめてから ` +
  `'herdr agent start ${name} --kind claude --pane ${pane}' を実行し、起動したら '@${handoff}' を打つ。` +
  `元の会話に戻るなら、ペインで 'claude --resume ${sid}'`;

// 呼び出し元のセッションがこの先で死ぬと、FAIL の文も OK の行も出ない。戻る手がかりを先に出しておく。
log(`旧セッション ${sid}（/exit の後にシェルに戻ったまま止まっていたら、ペインで claude --resume ${sid} を打てば元の会話に戻れる）`);
log('終了');
if (!prompt(pane, '/exit')) {
  // Herdr が入力を送る前に弾いたと分かるときだけ、対象は無傷と言える。
  // 判定は error.code で行う。stderr 全文への部分一致では、message に紛れた語を拾って
  // 「対象はそのまま動いている」と誤って断言することがある。
  const error = herdrError();
  if (SEND_REFUSED.has(herdrErrorCode())) {
    skip(`/exit を送れなかった（${error}）。対象はそのまま動いている`);
  }
  // code が取れないときもここ。stderr が JSON として読めないのは「送る前に失敗した」証拠に
  // ならない（送信した後に落ちた・シグナルで殺された・警告行が混ざった、のいずれもありうる）。
  // 対象が終了したまま起動されずに取り残されるほうが重いので、分からないときは FAIL 側に置く。
  fail(
    `/exit の送信が失敗した（${error || '理由不明'}）。対象が終了したまま起動されていないかもしれない。ペインを見ること。claude が動いていれば、入力欄に /exit が残っていないか確かめて消す。シェルに戻っていれば、${recovery}`,
  );
}

// 終了の確認画面（バックグラウンドの処理が残っているなど）が出たら Herdr が blocked を返す。
// 外から答えるのは、本人が止め忘れたものを外から止めることになるので採らない。
let back = false;
for (let i = 0; i < 60; i += 1) {
  sleep(1);
  if (shellIsBack(pane)) {
    back = true;
    break;
  }
  if (agentStatus(pane) === 'blocked') {
    fail(
      `/exit の後に確認画面が出ている。ペインで答えてもらうこと。キャンセルして claude が動き続けているなら何も変わっていないので、同じ引数で呼び直せる。終了してシェルに戻ったら、${recovery}`,
    );
  }
}
if (!back) fail(`シェルに戻らない。ペインを見ること。終了してシェルに戻っていたら、${recovery}`);

// シェルに戻っても、Herdr が旧エージェントの名前をすぐ外すとは限らない
if (!waitForNameRelease(name, 10)) {
  log(`名前 ${name} がまだ解放されていない。起動は試みる`);
}

log('起動');
if (!startAgent(name, pane)) {
  // agent_not_ready（起動が遅い・ダイアログが出ている）のときは claude は上がっていて名前も握っている。
  // そこへ claude --resume を打つと、新しいセッションへのプロンプトとして送られてしまう。
  fail(
    `起動できない（${herdrError()}）。ペインを見ること。claude が上がっていれば（確認やダイアログが出ていれば答えてから）'@${handoff}' を打つ。シェルのままなら、${recovery}`,
  );
}
if (!prompt(name, `@${handoff} 前セッションの引き継ぎ資料です。読んで現状を把握したら、${HOW_TO_PROCEED}`)) {
  fail(`起動はしたが資料を渡せなかった（${herdrError()}）。ペインで @${handoff} と打てば読める`);
}

process.stdout.write(`OK\t${pane}\t${name}\t${handoff}\tresume:${sid}\n`);
