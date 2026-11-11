#!/usr/bin/env node
// codex-usage.mjs の出力(secondary=週次枠)を、pace.mjs と同じ考え方（projection.mjs）で判定する。
//
// usage: node codex-usage.mjs | node codex-pace.mjs [--json] [--active-hours 12-20]
//   stdin が無ければ codex-usage.mjs を自分で叩く。
//   --json なら {pct, elapsedHours, remainingHours, activeElapsedHours, activeTotalHours, projected, verdict, primaryPct} を出す
//   （判定不可のとき projected と verdict は null。primaryPct は5時間枠の使用率）。

import { execFileSync } from 'node:child_process';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { activeHoursFrom, describe, project } from './projection.mjs';

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

let activeHours;
try {
  activeHours = activeHoursFrom(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}

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
const pct = secondary.usedPercent;
const result = project({ pct, resetsAtMs: secondary.resetsAt * 1000, windowHours, activeHours });

if (process.argv.includes('--json')) {
  const primaryPct = usage.primary?.usedPercent ?? null;
  console.log(JSON.stringify({ pct, elapsedHours, remainingHours, ...result, primaryPct }));
} else {
  console.log(describe('Codex Weekly', pct, remainingHours, activeHours, result));
}
