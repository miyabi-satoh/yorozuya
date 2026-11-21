#!/usr/bin/env node
// 端末の道具（lib/mux.mjs）で中身を分ける。引数と終了コードの決まりは、それぞれのファイルの先頭にある。
// Herdr: restart-herdr.mjs / Orca: restart-orca.mjs。どちらでもなければ Herdr 版に進む（分ける前と同じ止まり方にする）。

import { isOrca } from './lib/mux.mjs';

await import(isOrca() ? './restart-orca.mjs' : './restart-herdr.mjs');
