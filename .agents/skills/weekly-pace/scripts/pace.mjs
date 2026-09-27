#!/usr/bin/env node
// ステータスラインの「Weekly: X% | Weekly Reset: Ndd Hhr Mmin」から、週次サイクル（7日=168h）を
// 線形・比例で消費していくと仮定した場合の着地見込み%を概算する。あくまで目安。
//
// usage: pace.mjs [--text '<画面のテキスト>'] [--json]
//   --text を省けば stdin から読む（herdr pane read の出力をそのままパイプしてよい）。
//   --json なら {pct, elapsedHours, remainingHours, projected} を出す（判定不可のとき projected は null）。
//
// Weekly% はアカウント全体で共有される値なので、動いている claude ペインならどれを読んでもよい（自分のペインでもよい）。

import { text as readStream } from 'node:stream/consumers';

const args = process.argv.slice(2);
const textFlagIndex = args.indexOf('--text');
if (textFlagIndex >= 0 && args[textFlagIndex + 1] === undefined) {
  process.stderr.write('--text には値が要る。\n');
  process.exit(1);
}
// readFileSync(0) は上流がまだ書いていないパイプで EAGAIN になるので、ストリームで読み切る。
const raw = textFlagIndex >= 0 ? args[textFlagIndex + 1] : await readStream(process.stdin);
// ステータスラインの空白はノーブレークスペース（U+00A0）。
// 照合の前に普通の空白へ揃える（揃えないと "Weekly Reset" のような固定文字列がマッチしない）。
const text = raw.replace(/\u00a0/g, ' ');

const WEEKLY_CYCLE_HOURS = 168; // 7日

// 画面上部の会話に古い値が残っていることがあるので、最下部のステータスラインにあたる最後の一致を使う。
const lastMatch = (re) => [...text.matchAll(re)].at(-1);

// 例: "Weekly Reset: 6d 17hr 34m" / "Weekly Reset: 17hr 34m" / "Weekly Reset: 34m" / compact 表示の "6d17h34m"
const pctMatch = lastMatch(/Weekly:\s*(\d+(?:\.\d+)?)%/g);
const resetMatch = lastMatch(/Weekly Reset:\s*(?:(\d+)d\s*)?(?:(\d+)hr?\s*)?(?:(\d+)m)?/g);

if (!pctMatch || !resetMatch || (!resetMatch[1] && !resetMatch[2] && !resetMatch[3])) {
  process.stderr.write('Weekly% か Weekly Reset を読み取れなかった。ステータスラインの表示が既定と違うかもしれない。\n');
  process.exit(1);
}

const pct = Number(pctMatch[1]);
if (!Number.isFinite(pct)) {
  process.stderr.write(`Weekly% の値がおかしい: "${pctMatch[1]}"\n`);
  process.exit(1);
}
const days = Number(resetMatch[1] ?? 0);
const hours = Number(resetMatch[2] ?? 0);
const minutes = Number(resetMatch[3] ?? 0);
const remainingHours = days * 24 + hours + minutes / 60;
const elapsedHours = WEEKLY_CYCLE_HOURS - remainingHours;

const fmt1 = (n) => Math.round(n * 10) / 10;
const projected = elapsedHours < 2 ? null : (pct / elapsedHours) * WEEKLY_CYCLE_HOURS;

if (args.includes('--json')) {
  console.log(JSON.stringify({ pct, elapsedHours, remainingHours, projected }));
  process.exit(0);
}

if (projected === null) {
  console.log(
    `Weekly ${pct}% ・ サイクル開始から ${fmt1(elapsedHours)}h しか経っていない。判定不可（目安にするには経過が短すぎる）`
  );
  process.exit(0);
}

const verdict = projected > 100 ? 'ハイペース' : '順調';

console.log(
  `Weekly ${pct}%（経過 ${fmt1(elapsedHours)}h / リセットまで残り ${fmt1(remainingHours)}h）→ このペースの着地見込み ${fmt1(projected)}% … ${verdict}（線形外挿の目安）`
);
