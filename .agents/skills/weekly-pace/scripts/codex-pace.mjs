#!/usr/bin/env node
// codex-usage.mjs の出力(secondary=週次枠)を、pace.mjs と同じ「線形外挿で着地見込み%」の考え方で判定する。
//
// usage: node codex-usage.mjs | node codex-pace.mjs [--json]
//   stdin が無ければ codex-usage.mjs を自分で叩く。
//   --json なら {pct, elapsedHours, remainingHours, projected, primaryPct} を出す
//   （判定不可のとき projected は null。primaryPct は5時間枠の使用率）。

import { execFileSync } from 'node:child_process';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadUsage() {
  if (!process.stdin.isTTY) {
    // readFileSync(0) は上流がまだ書いていないパイプで EAGAIN になるので、ストリームで読み切る。
    const raw = await text(process.stdin);
    if (raw.trim()) return JSON.parse(raw);
  }
  const raw = execFileSync('node', [join(__dirname, 'codex-usage.mjs')], { encoding: 'utf8' });
  return JSON.parse(raw);
}

const fmt1 = (n) => Math.round(n * 10) / 10;

let usage;
try {
  usage = await loadUsage();
} catch (err) {
  process.stderr.write(`Codexの使用量を取得できなかった: ${err.message}\n`);
  process.exit(1);
}

const secondary = usage.secondary;
if (!secondary || typeof secondary.usedPercent !== 'number' || !secondary.resetsAt || !secondary.windowDurationMins) {
  process.stderr.write('secondary(週次枠)の情報が取れなかった。\n');
  process.exit(1);
}

const windowHours = secondary.windowDurationMins / 60;
const remainingHours = (secondary.resetsAt * 1000 - Date.now()) / 3_600_000;
const elapsedHours = windowHours - remainingHours;
const projected = elapsedHours < 2 ? null : (secondary.usedPercent / elapsedHours) * windowHours;

if (process.argv.includes('--json')) {
  const primaryPct = usage.primary?.usedPercent ?? null;
  console.log(JSON.stringify({ pct: secondary.usedPercent, elapsedHours, remainingHours, projected, primaryPct }));
  process.exit(0);
}

if (projected === null) {
  console.log(
    `Codex Weekly ${secondary.usedPercent}% ・ サイクル開始から ${fmt1(elapsedHours)}h しか経っていない。判定不可（目安にするには経過が短すぎる）`
  );
  process.exit(0);
}

const verdict = projected > 100 ? 'ハイペース' : '順調';

console.log(
  `Codex Weekly ${secondary.usedPercent}%（経過 ${fmt1(elapsedHours)}h / リセットまで残り ${fmt1(remainingHours)}h）→ このペースの着地見込み ${fmt1(projected)}% … ${verdict}（線形外挿の目安）`
);
