#!/usr/bin/env node
// ステータスラインの「Weekly: X% | Weekly Reset: Ndd Hhr Mmin」から、週次サイクル（7日=168h）を
// 線形・比例で消費していくと仮定した場合の着地見込み%を概算する。あくまで目安。
//
// usage: pace.mjs [--text '<画面のテキスト>']
//   --text を省けば stdin から読む（herdr pane read の出力をそのままパイプしてよい）。
//
// Weekly% はアカウント全体で共有される値なので、動いている claude ペインならどれを読んでもよい。
// 自セッションのステータスラインは自分では読めないので、他のペインを読むこと。

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const textFlagIndex = args.indexOf('--text');
const raw = textFlagIndex >= 0 ? args[textFlagIndex + 1] : readFileSync(0, 'utf8');
// ステータスラインの空白はノーブレークスペース（U+00A0）。watch-context.mjs と同じく、
// 照合の前に普通の空白へ揃える（揃えないと "Weekly Reset" のような固定文字列がマッチしない）。
const text = raw.replace(/ /g, ' ');

const WEEKLY_CYCLE_HOURS = 168; // 7日

// 例: "Weekly: 7.0% | Weekly Reset: 6d 17hr 34m" / "Weekly Reset: 17hr 34m" / "Weekly Reset: 34m"
const pctMatch = text.match(/Weekly:\s*([\d.]+)%/);
const resetMatch = text.match(/Weekly Reset:\s*(?:(\d+)d\s*)?(?:(\d+)hr\s*)?(?:(\d+)m)?/);

if (!pctMatch || !resetMatch || (!resetMatch[1] && !resetMatch[2] && !resetMatch[3])) {
  process.stderr.write('Weekly% か Weekly Reset を読み取れなかった。ステータスラインの表示が既定と違うかもしれない。\n');
  process.exit(1);
}

const pct = Number(pctMatch[1]);
const days = Number(resetMatch[1] ?? 0);
const hours = Number(resetMatch[2] ?? 0);
const minutes = Number(resetMatch[3] ?? 0);
const remainingHours = days * 24 + hours + minutes / 60;
const elapsedHours = WEEKLY_CYCLE_HOURS - remainingHours;

const fmt1 = (n) => Math.round(n * 10) / 10;

if (elapsedHours < 2) {
  console.log(
    `Weekly ${pct}% ・ サイクル開始から ${fmt1(elapsedHours)}h しか経っていない。判定不可（目安にするには経過が短すぎる）`
  );
  process.exit(0);
}

const projected = (pct / elapsedHours) * WEEKLY_CYCLE_HOURS;
const verdict = projected > 100 ? 'ハイペース' : '順調';

console.log(
  `Weekly ${pct}%（経過 ${fmt1(elapsedHours)}h / リセットまで残り ${fmt1(remainingHours)}h）→ このペースの着地見込み ${fmt1(projected)}% … ${verdict}（線形外挿の目安）`
);
