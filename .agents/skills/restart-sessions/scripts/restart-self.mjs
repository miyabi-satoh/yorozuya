#!/usr/bin/env node
// 端末の道具（lib/mux.mjs）で中身を分ける。引数と終了コードの決まりは、それぞれのファイルの先頭にある。
// Herdr: restart-self-herdr.mjs / Orca: restart-self-orca.mjs。どちらでもなければ Herdr 版に進む（分ける前と同じ止まり方にする）。

import { isOrca } from './lib/mux.mjs';

await import(isOrca() ? './restart-self-orca.mjs' : './restart-self-herdr.mjs');
