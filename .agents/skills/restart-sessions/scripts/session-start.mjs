#!/usr/bin/env node
// SessionStart の hook から呼ぶ。見張りを始めさせる指示を、config.local.json の中身に合わせて会話に差し込む。
// hook から Monitor は呼べないので、始めるのはセッションが最初に返事をするとき。
// 知らせのたびに確認するか（confirm）は、ここで文に織り込む。セッションに設定ファイルを読みに行かせない。

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG, loadConfig } from './lib/config.mjs';

// 差し込む文のコマンドと手順のファイルは絶対パスにする。セッションをどこで起動しても、そのまま走らせられる。
const WATCH = fileURLToPath(new URL('./watch-context.mjs', import.meta.url));
const GUIDE = fileURLToPath(new URL('../watch.md', import.meta.url));

const say = (...lines) => process.stdout.write(`${lines.join('\n')}\n`);

// mod（context-watch）が読み込まれていれば、各セッションが自分を見張るので、外の見張りは始めさせない。
// CLAUDE_CODE_PLUGIN_DIRS の各フォルダは、それ自身か中のフォルダがプラグインになる。
const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return '';
  }
};
const MOD = real(fileURLToPath(new URL('../mod', import.meta.url)));
const pluginDirs = (process.env.CLAUDE_CODE_PLUGIN_DIRS ?? '')
  .split(delimiter)
  .filter(Boolean)
  .map((dir) => dir.replace(/^~(?=$|[\\/])/, homedir()));
const hasMod = pluginDirs.some(
  (dir) => real(dir) === MOD || (existsSync(dir) && readdirSync(dir).some((name) => real(join(dir, name)) === MOD)),
);
if (MOD && hasMod) process.exit(0);

const { config, error } = loadConfig();

// 見分けやすい設定の誤り（pattern の構文、confirm の型）は、始めさせずにここで伝える。ほかの誤りは試運転で止まる。
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
    `[コンテキストの見張り] このセッションで最初に返事をするとき、restart-sessions スキルの ${GUIDE}（コンテキストを見張る）に従い（「始める」の手順2の試運転から）、見張りを始めること。mcp__context-watch__start ツールがあればそれを呼ぶ（張り直しは要らない）。無ければ、次のコマンドを Monitor（timeout_ms は上限の 30 分。切れたら同じコマンドで張り直す）で走らせる。すでに見張りを走らせていれば、二重には始めない。`,
    `node "${WATCH}"`,
    config.confirm === true
      ? '知らせのたびに、再起動や /clear に進んでよいかをユーザーに確認する（config.local.json の confirm）。'
      : '知らせは確認なしで流す。',
    'grep で落とさないこと（Claude Code のシェルの grep は走りっぱなしの入力を溜め込み、OVER が届かなくなる）。',
  );
}
