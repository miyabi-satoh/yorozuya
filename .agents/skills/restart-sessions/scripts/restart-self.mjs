#!/usr/bin/env node
// Yorozuya 自身のセッションを、自ペインを分割した新ペインで立て直す。
// usage: restart-self.mjs <資料の絶対パス> [name]
//
// 対象セッションの再起動とは手順が逆になる。死ぬ側が /exit を送るとスクリプトも道連れに
// なるため、新セッションを先に立て、旧ペインを閉じるのは新セッションに任せる。
// 資料を読み終えてから閉じるので、起動や読み込みが失敗すれば呼び出し元は生き残る。
//
// 終了コード: 0 依頼まで完了 / 1 失敗。失敗は2種類あり、stderr の接頭辞で見分ける。
//   SKIP — 何も変えずに止まった。
//   FAIL — 新ペインを立てた後に止まった。何が残ったかをメッセージに書く。

import { isAbsolute } from 'node:path';

import { handoffProblem } from './lib/handoff.mjs';
import {
  herdr,
  herdrError,
  herdrJson,
  NAME_PATTERN,
  paneHoldingName,
  prompt,
  startAgent,
  waitForNameRelease,
} from './lib/herdr.mjs';

const [handoff, name = 'yorozuya'] = process.argv.slice(2);
if (!handoff) {
  process.stderr.write('usage: restart-self.mjs <資料の絶対パス> [name]\n');
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
if (!NAME_PATTERN.test(name)) skip(`Herdr の名前の規則（先頭は小文字・英数と _ - のみ・32字以内）に合わない: ${name}`);

// $HERDR_PANE_ID はペイン移動前の ID のまま残ることがあるので、現在の ID を引き直す
const current = herdrJson(['pane', 'current', '--current'])?.result?.pane;
const self = current?.pane_id ?? '';
const sid = current?.agent_session?.value ?? '';
if (!self || !sid) skip(`自分のペインかセッションIDを特定できない（${herdrError()}）`);

// このスクリプトは「自分は claude で、資料を書き終えている」前提で、新セッションに旧ペインを
// 閉じさせる。claude 以外から呼ばれると、無関係のペインを強制終了させることになる。
if (current.agent !== 'claude') skip(`このペインで動いているのは claude ではない: ${current.agent ?? '不明'}`);

// 新ペインは「このセッションと同じ場所」で起動したい。
// process.cwd() は cd した先に動くので使わない。schema 上 cwd は必須ではないので、
// 取れなければ foreground_cwd を見る。どちらも無ければ止める。適当な値で代用すると、
// リポジトリの外で起動して CLAUDE.md も AGENTS.md も読まないセッションができる。
const cwd = [current.cwd, current.foreground_cwd].find((value) => typeof value === 'string' && isAbsolute(value));
if (!cwd) skip('ペインの cwd を Herdr から取れない。新ペインをどこで起動するか決められないので止まる');

// 旧ペイン（自分）が同じ名前を握っていると、新ペインで agent start が失敗する。
// Herdr の名前は一意なので、起動の直前に外し、失敗したら戻す。
const holder = paneHoldingName(name);
if (holder === null) skip(`Herdr のエージェント一覧を取得できない（${herdrError()}）`);
if (holder && holder !== self) skip(`名前 ${name} は ${holder} が使用中`);
const selfHoldsName = holder === self;

// 縦長のペインは下に割る。旧を閉じれば新が元の大きさに戻る。
// 焦点は呼び出し元に残す。旧ペインが閉じた時点で焦点は別のペインへ移る（移り先は Herdr 任せ）。
// --cwd は省かない。省くと新ペインの cwd が利用者の terminal.new_cwd 設定に従う。
const splitOut = herdr(['pane', 'split', '--current', '--direction', 'down', '--cwd', cwd, '--no-focus']);
if (splitOut === null) skip(`ペインを分割できなかった（${herdrError()}）。何も変えていない`);

let created = '';
try {
  created = JSON.parse(splitOut)?.result?.pane?.pane_id ?? '';
} catch {
  /* 出力が JSON として読めない。分割そのものは成功している */
}
// herdr が 0 を返した以上、ペインはできている。ID が読めないだけ。
// ここで「何も変えていない」と言うと、再実行のたびにペインが増える。
if (!created) {
  fail(
    `ペインは分割できたが ID を読み取れない（Herdr の出力の形が変わった可能性）。新しいペインが残っているので手で閉じること。出力: ${splitOut.trim().slice(0, 200)}`,
  );
}
log(`新ペイン ${created}`);
// 以降の起動・名前の付け外し・閉じる操作は created をそのまま使う。ペインIDは使い回されないので
// （Herdr の文書）、途中でこのペインが閉じられても、同じIDの別ペインに作用することは無い。

// --- ここから先は、失敗したら何が残ったかを必ず伝える ---

let nameCleared = false;

// createdOpen は、新ペインを閉じずに残した経路かどうか。2つの経路で名前の外し方が違う。
// - 残した経路（起動失敗）: agent start が agent_not_ready で失敗すると、Herdr は名前を新ペインに
//   割り当てたまま保つ（ダイアログに答えてから続けられるように）。閉じないので解放されない。
//   握られていたら先に --clear で外す。外さずに rename すると重複で失敗し、生きている旧セッションが
//   無名のまま残り、名前で届く先が文脈の無いペインになる。
// - 閉じた経路（依頼の送信失敗）: 閉じた直後は、閉じたペインがしばらく名前を握って見える。
//   そのペインはもう無いので --clear は効かない。解放を待ってから rename する。
const restoreName = (createdOpen) => {
  if (!nameCleared) return '';
  // 一覧が一度取れなかった（null）だけで「握っていない」と見なすと、残したペインが握ったままの名前を
  // 解放されないまま待ち、rename が重複で失敗して旧セッションが無名で残る。分からないときも --clear を試す。
  const holder = createdOpen ? paneHoldingName(name) : '';
  if (createdOpen && (holder === created || holder === null) && herdr(['agent', 'rename', created, '--clear']) === null) {
    return `新ペイン ${created} が Herdr 名 ${name} を握ったままで、外せなかった（${herdrError()}）。旧セッションは無名のまま。まず 'herdr agent rename ${created} --clear' を手で試し、通ったら 'herdr agent rename ${self} ${name}' で戻す。通らなければ新ペインを閉じ（閉じれば名前は数秒で外れる）、'herdr agent list' で名前が消えたのを確かめてから 'herdr agent rename ${self} ${name}' で戻す。`;
  }
  waitForNameRelease(name, 10);
  return herdr(['agent', 'rename', self, name]) !== null
    ? `旧ペインの名前は ${name} に戻した。`
    : `旧ペインの Herdr 名を戻せなかった（${herdrError()}）。'herdr agent rename ${self} ${name}' を手で実行すること。`;
};

const closeCreated = () =>
  herdr(['pane', 'close', created]) !== null
    ? '新ペインは閉じた。'
    : `新ペイン ${created} が残っている（herdr pane close ${created} で閉じること）。`;

if (selfHoldsName) {
  if (herdr(['agent', 'rename', self, '--clear']) === null) {
    const error = herdrError();
    fail(`旧ペインの Herdr 名を外せなかった（${error}）。${closeCreated()}旧セッションはそのまま`);
  }
  nameCleared = true;
}

// 起動に失敗しても新ペインは閉じない。信頼ダイアログのように「ユーザーがそのペインで
// 答えれば進む」種類の失敗があり、閉じると答えようとした画面が目の前で消える。
// 2026-09-12 に実際にそれを起こしている。事前に設定ファイルを覗いて予測するのではなく、
// 失敗したときに答えられる状態で止まる形にした。
if (!startAgent(name, created)) {
  // restoreName() は中で herdr を呼ぶので、先に理由を取り出しておく。
  // 名前を手で戻す手順があるときは、ペインを閉じる案内より先に読ませる。
  const error = herdrError();
  const nameNote = restoreName(true);
  fail(
    `新セッションを起動できなかった（${error}）。新ペイン ${created} は開いたまま残した。${nameNote}` +
      `信頼ダイアログや確認が出ていればペインで答えること。答えたら 'herdr pane close ${created}' で閉じてから、同じ引数で呼び直す。` +
      `閉じずに呼び直すとペインが増える。旧セッションはそのまま`,
  );
}
log('起動');

// --wait は付けない。待っている間に旧ペインごと閉じられるため、待つ意味がない。
const request = `@${handoff} Yorozuya 自身の再起動です。前セッション（ペイン ${self} / セッション ${sid}）は資料を書き終えて、閉じられるのを待っています。

手順:
1. 引き継ぎ資料を読んで現状を把握する。
2. 把握できたら 'herdr pane close ${self}' で前セッションのペインを閉じる。閉じると前セッションは強制終了になる（資料は書けているので問題ない。戻りたくなったら 'claude --resume ${sid}'）。読み終える前に閉じないこと。
3. ユーザーに再起動の結果を報告し、指示を待つ。`;

// ここは起動済みで、資料だけが渡っていない。ユーザーが答えれば進む状態ではないので、
// 閉じて元の一枚に戻す。
if (!prompt(created, request)) {
  const error = herdrError();
  fail(`新セッションに依頼を送れなかった（${error}）。${closeCreated()}${restoreName(false)}旧セッションはそのまま`);
}

process.stdout.write(`OK\t${self}\t${created}\t${name}\t${handoff}\tresume:${sid}\n`);

// 呼び出し元はここで黙って止まる。報告は新セッションが行う。
// 旧ペインは読み終えた新セッションに閉じられるので、ここから先の出力は誰にも読まれない。
log('ここで止まる。報告は不要（この先の出力は読まれないまま消える）');
