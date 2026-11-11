#!/usr/bin/env node
// Claude の週次枠（7日=168h）を、毎日の稼働の時間帯に線形・比例で消費していくと仮定した場合の着地見込み%を概算する。
// あくまで目安。数え方は projection.mjs。
//
// usage: pace.mjs [--text '<画面のテキスト>'] [--json] [--active-hours 12-20]
//   入力が無ければ claude-usage.mjs（使用量 API）を自分で叩く。ふだんはこれでよい。
//   stdin に claude-usage.mjs の JSON を渡してもよい。
//   API で取れないときの予備として、ステータスラインの「Weekly: X% | Weekly Reset: Nd Hhr Mm」を含む画面のテキスト
//   （--text か stdin。herdr pane read の出力をそのままパイプしてよい）からも読める。
//   --json なら {pct, elapsedHours, remainingHours, activeElapsedHours, activeTotalHours, projected, verdict, primaryPct} を出す
//   （判定不可のとき projected と verdict は null。primaryPct は5時間枠の使用率で、画面から読んだときは null）。
//   --active-hours は稼働の時間帯（既定と環境変数は projection.mjs）。
//
// Weekly% はアカウント全体で共有される値なので、どのマシン・どのセッションで取っても同じ。

import { execFileSync } from 'node:child_process';
import { text as readStream } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { activeHoursFrom, describe, project } from './projection.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEEKLY_CYCLE_HOURS = 168; // 7日

const args = process.argv.slice(2);
const textFlagIndex = args.indexOf('--text');
if (textFlagIndex >= 0 && args[textFlagIndex + 1] === undefined) {
  process.stderr.write('--text には値が要る。\n');
  process.exit(1);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function readInput() {
  if (textFlagIndex >= 0) return args[textFlagIndex + 1];
  if (process.stdin.isTTY) return '';
  // readFileSync(0) は上流がまだ書いていないパイプで EAGAIN になるので、ストリームで読み切る。
  return readStream(process.stdin);
}

function fromUsage(usage) {
  const secondary = usage.secondary;
  if (!secondary || typeof secondary.usedPercent !== 'number' || !secondary.resetsAt) {
    fail('secondary(週次枠)の情報が取れなかった。');
  }
  return {
    pct: secondary.usedPercent,
    remainingHours: (secondary.resetsAt * 1000 - Date.now()) / 3_600_000,
    primaryPct: usage.primary?.usedPercent ?? null,
  };
}

function fromScreen(raw) {
  // ステータスラインの空白はノーブレークスペース（U+00A0）。
  // 照合の前に普通の空白へ揃える（揃えないと "Weekly Reset" のような固定文字列がマッチしない）。
  const text = raw.replace(/ /g, ' ');
  // 画面上部の会話に古い値が残っていることがあるので、最下部のステータスラインにあたる最後の一致を使う。
  const lastMatch = (re) => [...text.matchAll(re)].at(-1);
  // 例: "Weekly Reset: 6d 17hr 34m" / "Weekly Reset: 17hr 34m" / "Weekly Reset: 34m" / compact 表示の "6d17h34m"
  const pctMatch = lastMatch(/Weekly:\s*(\d+(?:\.\d+)?)%/g);
  const resetMatch = lastMatch(/Weekly Reset:\s*(?:(\d+)d\s*)?(?:(\d+)hr?\s*)?(?:(\d+)m)?/g);
  if (!pctMatch || !resetMatch || (!resetMatch[1] && !resetMatch[2] && !resetMatch[3])) {
    fail('Weekly% か Weekly Reset を読み取れなかった。ステータスラインの表示が既定と違うかもしれない。');
  }
  const pct = Number(pctMatch[1]);
  if (!Number.isFinite(pct)) fail(`Weekly% の値がおかしい: "${pctMatch[1]}"`);
  const [days, hours, minutes] = [1, 2, 3].map((i) => Number(resetMatch[i] ?? 0));
  return { pct, remainingHours: days * 24 + hours + minutes / 60, primaryPct: null };
}

function fetchUsage() {
  try {
    // 失敗の理由（トークン切れ・429 など）は claude-usage.mjs が stderr に出すので、そのまま流す。
    const raw = execFileSync('node', [join(__dirname, 'claude-usage.mjs')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    return JSON.parse(raw);
  } catch {
    fail('Claude の使用量を取得できなかった。画面のテキストを渡せば、ステータスラインから読める。');
  }
}

let activeHours;
try {
  activeHours = activeHoursFrom(args);
} catch (error) {
  fail(error.message);
}

const input = (await readInput()).trim();
const { pct, remainingHours, primaryPct } = !input
  ? fromUsage(fetchUsage())
  : input.startsWith('{')
    ? fromUsage(JSON.parse(input))
    : fromScreen(input);
const elapsedHours = WEEKLY_CYCLE_HOURS - remainingHours;
// 画面から読んだときは残りが分単位なので、リセットの時刻も分単位の誤差を持つ。目安には足りる。
const result = project({
  pct,
  resetsAtMs: Date.now() + remainingHours * 3_600_000,
  windowHours: WEEKLY_CYCLE_HOURS,
  activeHours,
});

if (args.includes('--json')) {
  console.log(JSON.stringify({ pct, elapsedHours, remainingHours, ...result, primaryPct }));
} else {
  console.log(describe('Weekly', pct, remainingHours, activeHours, result));
}
