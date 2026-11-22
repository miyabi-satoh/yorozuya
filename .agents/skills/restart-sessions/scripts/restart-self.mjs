#!/usr/bin/env node
// 端末の道具（lib/mux.mjs）で中身を分ける。引数と終了コードの決まりは、それぞれのファイルの先頭にある。
// hc: restart-self-hc.mjs / Herdr: restart-self-herdr.mjs。どれでもなければ Herdr 版に進む（分ける前と同じ止まり方にする）。

import { backend } from './lib/mux.mjs';

await import(`./restart-self-${{ hc: 'hc' }[backend()] ?? 'herdr'}.mjs`);
