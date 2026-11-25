#!/usr/bin/env node
// 端末の道具（lib/mux.mjs）で中身を分ける。hc: exit-self-hc.mjs。
// Herdr 版は無い。自分のペインを閉じると、閉じる処理を流す自分も終わる。hc のように切り離した別プロセスに閉じさせる手を実機で確かめていないので、止まる。

import { backend } from './lib/mux.mjs';

if (backend() !== 'hc') {
  process.stderr.write('[exit-self] SKIP: hc の端末でだけ使える（Herdr のペインを自分で閉じる手は未確認）。終わらずに続けること\n');
  process.exit(1);
}
await import('./exit-self-hc.mjs');
