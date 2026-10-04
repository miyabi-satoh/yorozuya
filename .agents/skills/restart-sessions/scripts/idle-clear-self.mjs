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

import { agentStatus, backgroundWorkHint, herdrError, herdrJson, inputDraft, prompt, sleep } from './lib/herdr.mjs';

const skip = (message) => {
  process.stderr.write(`[idle-clear-self] SKIP: ${message}\n`);
  process.exit(1);
};

const [, , mode, pane, handoff] = process.argv;

// 切り離した子: /clear を送り、画面が入れ替わるのを待ってから続きを送る。
if (mode === '--send') {
  prompt(pane, '/clear');
  sleep(3);
  prompt(
    pane,
    `@${handoff} /clear で消えた前任（このペインの直前のセッション）の会話ログです。最新のやり取りは「# 前の資料」の見出しの直前までで、見出しの下は古い世代です。読んで状況を短く確かめ、ユーザーの答え待ちだったなら同じ問いを出し直し、そうでなければ指示を待ってください（作業は始めない）。`,
  );
  process.exit(0);
}

// $HERDR_PANE_ID はペイン移動前の ID のまま残ることがあるので、現在の ID を引き直す
const current = herdrJson(['pane', 'current', '--current'])?.result?.pane;
const self = current?.pane_id ?? '';
const sid = current?.agent_session?.value ?? '';
if (!self || !sid) skip(`自分のペインかセッションIDを特定できない（${herdrError()}）`);

// idle-clear.md の手順1と同じ照合。どれかに当たれば流さない。
const status = agentStatus(self);
if (status !== 'idle') skip(`ペインが idle でない（${status || '取れない'}）`);
const draft = inputDraft(self);
if (draft === null) skip('入力欄を読めない');
if (draft !== '') skip('入力欄に書きかけがある');
const background = backgroundWorkHint(self);
if (background) skip(`バックグラウンドの処理が動いている（${background}）`);

const dir = join(tmpdir(), 'restart-sessions');
mkdirSync(dir, { recursive: true });
const out = join(dir, `idle-${sid}.md`);
const extract = fileURLToPath(new URL('./extract-transcript.mjs', import.meta.url));
try {
  execFileSync(process.execPath, [extract, sid, '--out', out], { stdio: ['ignore', 'ignore', 'pipe'] });
} catch (error) {
  skip(`会話ログを抜き出せない: ${String(error.stderr ?? error).trim()}`);
}

const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--send', self, out], { detached: true, stdio: 'ignore' });
child.unref();
process.stdout.write(`${out}\n`);
