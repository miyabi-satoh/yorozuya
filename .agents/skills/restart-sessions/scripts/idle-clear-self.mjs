#!/usr/bin/env node
// 放置で大きくなった自分の会話を、自分のペインで /clear して続ける（idle-clear.md を自分に当てる形）。
// context-watch の mod が、放置されたセッションの中から呼ぶ。モデルのターンを使わないので、冷えたキャッシュを読み直さない。
// usage: idle-clear-self.mjs
//
// /clear でセッションが入れ替わっても続きを送れるよう、確かめを済ませたら切り離した子で /clear と続きを送る。
// 終了コード: 0 送った（子に任せた）/ 1 SKIP（何も変えずに止まった。理由は stderr）。

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sleep } from './lib/herdr.mjs';
import { backgroundWorkHint, idleStatus, inputDraft, isHc, isOrca, lastError, prompt, self as selfOf } from './lib/mux.mjs';

const skip = (message) => {
  process.stderr.write(`[idle-clear-self] SKIP: ${message}\n`);
  process.exit(1);
};

const [, , mode, pane, handoff, shells] = process.argv;

// 切り離した子: /clear を送り、画面が入れ替わるのを待ってから続きを送る。
// Orca と hc の端末では、/clear を送れなければ続きを送らず、待つ間にユーザーが打ち始めたか何かが動き出していても送らない
// （続きが打ちかけの末尾につながって送信されるため）。入力欄が読めない（/clear の後でまだ描かれていない）間は数回読み直し、
// 書きかけが見えたときだけやめる。やめると /clear の後の会話に資料が渡らないので、読めないだけでは止めない。Herdr は分ける前のまま。
if (mode === '--send') {
  const careful = isOrca() || isHc();
  if (!prompt(pane, '/clear') && careful) process.exit(1);
  sleep(3);
  if (careful) {
    let draft = inputDraft(pane);
    for (let i = 0; draft === null && i < 5; i += 1) {
      sleep(1);
      draft = inputDraft(pane);
    }
    if (draft || ['working', 'blocked'].includes(idleStatus(pane).status)) process.exit(1);
  }
  prompt(
    pane,
    `@${handoff} /clear で消えた前任（このペインの直前のセッション）の会話ログです。最新のやり取りは「# 前の資料」の見出しの直前までで、見出しの下は古い世代です。読んで状況を短く確かめ、ユーザーの答え待ちだったなら同じ問いを出し直し、そうでなければ指示を待ってください（作業は始めない）。${shells === 'yes' ? '前任のバックグラウンドのシェルが残っています。その終わりの知らせが届いたら、会話ログにある予定に沿って続けてかまいません。' : ''}`,
  );
  process.exit(0);
}

// Herdr のペイン・Orca の端末・hc の端末（lib/mux.mjs）。切り離した子は、親の環境を引き継ぐので同じ道具に送る。
const { id: self, sid } = selfOf();
if (!self || !sid) skip(`自分のペインかセッションIDを特定できない（${lastError()}）`);

// idle-clear.md の手順1と同じ照合。どれかに当たれば流さない。
const { idle, status } = idleStatus(self);
if (!idle) skip(`ペインが idle でない（${status || '取れない'}）`);
const draft = inputDraft(self);
if (draft === null) skip('入力欄を読めない');
if (draft !== '') skip('入力欄に書きかけがある');
// シェルは /clear の後も動き続け、終わりの知らせは /clear の後の小さい会話に届く（2.1.289 で確認）。
// 見送ると、知らせが冷えた大きい会話のターンを起こして読み直しになるので、シェルだけなら流す。
// Monitor・バックグラウンドのサブエージェントは /clear の後を確かめていないので見送る。
const background = backgroundWorkHint(self);
if (background && /\d+\s+(?:monitors?|tasks?)\b/.test(background)) skip(`バックグラウンドの処理が動いている（${background}）`);
const hasShells = background ? 'yes' : 'no';

const dir = join(tmpdir(), 'restart-sessions');
mkdirSync(dir, { recursive: true });
const out = join(dir, `idle-${sid}.md`);
const extract = fileURLToPath(new URL('./extract-transcript.mjs', import.meta.url));
try {
  execFileSync(process.execPath, [extract, sid, '--out', out], { stdio: ['ignore', 'ignore', 'pipe'] });
} catch (error) {
  skip(`会話ログを抜き出せない: ${String(error.stderr ?? error).trim()}`);
}

const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--send', self, out, hasShells], { detached: true, stdio: 'ignore' });
child.unref();
process.stdout.write(`${out}\n`);
