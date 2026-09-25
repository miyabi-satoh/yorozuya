#!/usr/bin/env node
// SessionStart の hook から呼ぶ。見張りを始めさせる指示を、config.local.json の中身に合わせて会話に差し込む。
// hook から Monitor は呼べないので、始めるのはセッションが最初に返事をするとき。
// 知らせのたびに確認するか（confirm）は、ここで文に織り込む。セッションに設定ファイルを読みに行かせない。

import { fileURLToPath } from 'node:url';

import { CONFIG, loadConfig } from './lib/config.mjs';

// 差し込む文のコマンドは絶対パスにする。セッションをどこで起動しても、そのまま走らせられる。
const WATCH = fileURLToPath(new URL('./watch-context.mjs', import.meta.url));

const say = (...lines) => process.stdout.write(`${lines.join('\n')}\n`);
const { config, error } = loadConfig();

// 設定の誤りは、始めさせずにここで伝える（試運転まで進ませない）。
let problem = '';
if (!error && config.watch?.pattern) {
  try {
    new RegExp(config.watch.pattern);
  } catch (regexError) {
    problem = `${CONFIG} の watch.pattern を正規表現として読めない: ${regexError.message}`;
  }
}
// "true" のような文字列を黙って false と読むと、確認するつもりの設定が効かない。
if (!error && !problem && config.confirm !== undefined && typeof config.confirm !== 'boolean') {
  problem = `${CONFIG} の confirm は true か false で書くこと`;
}

if (error || problem || !config.watch?.pattern) {
  say(
    '[コンテキストの見張り] 設定が無いか誤っているので始めない。このセッションで最初に返事をするとき、次をユーザーに伝えること。',
    error || problem || `${CONFIG} が無いか、watch.pattern が無い。config.example.json を写して作り、pattern をステータスラインの使用率の表示に合わせると、次の起動から見張りが始まる。`,
  );
} else {
  say(
    '[コンテキストの見張り] このセッションで最初に返事をするとき、restart-sessions スキルの「コンテキストを見張る」に従い（「始める」の手順2の試運転から）、次のコマンドを Monitor（timeout_ms は上限の 30 分。切れたら同じコマンドで張り直す）で走らせること。すでに見張りを走らせていれば、二重には始めない。',
    `node "${WATCH}"`,
    config.confirm === true
      ? '知らせのたびに、再起動や /clear に進んでよいかをユーザーに確認する（config.local.json の confirm）。'
      : '知らせは確認なしで流す。',
    'grep で落とさないこと（Claude Code のシェルの grep は走りっぱなしの入力を溜め込み、OVER が届かなくなる）。',
  );
}
