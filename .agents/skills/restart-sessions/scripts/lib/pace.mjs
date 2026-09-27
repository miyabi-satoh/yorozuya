// 再起動した新セッションに、週次枠のペースの一文を添える。数字は weekly-pace スキルのスクリプトで取る。
//
// Claude がハイペースで Codex に余裕があるときだけ、任せられる作業を Codex に回すよう書く。
// 再起動のたびに入るので、毎回のプロンプトで差し込む hook を各セッションに置かずに済む。
// 最長で約18秒かかる（画面の読み取り3秒・pace.mjs 3秒・codex の問い合わせ12秒）ので、呼び出し側は事前の確かめより前に呼ぶ（確かめてから /exit までを空けない）。
// 読み違えても、新セッションが作業をどちらに回すかが変わるだけで、後戻りできない操作には進まない。
// 取れないとき（Herdr の外・ステータスラインに Weekly が無い・codex が無い）は何も添えない。

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { herdrJson } from './herdr.mjs';

const SCRIPTS = fileURLToPath(new URL('../../../weekly-pace/scripts/', import.meta.url));
// Codex の5時間枠がここまで埋まっていたら、回しても rate limit で落ちるので添えない
const CODEX_PRIMARY_LIMIT = 80;

function pace(script, input, timeout) {
  try {
    const out = execFileSync('node', [`${SCRIPTS}${script}`, '--json'], {
      input,
      encoding: 'utf8',
      timeout,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// Weekly% はアカウント全体で共有されるので、呼び出し元の自分のペインを読めば足りる。
// $HERDR_PANE_ID はペイン移動前の ID のまま残ることがあるので、渡されなければ現在の ID を引く。
export function paceNote(pane = herdrJson(['pane', 'current', '--current'])?.result?.pane?.pane_id) {
  if (!pane) return '';
  let screen;
  try {
    screen = execFileSync('herdr', ['pane', 'read', pane, '--source', 'visible'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
  const claude = pace('pace.mjs', screen, 3000);
  if (!claude || claude.projected === null || claude.projected <= 100) return '';

  const codex = pace('codex-pace.mjs', '', 12000);
  // 週の頭で判定不可（projected が null）のときは、まだほとんど使っていないので余裕ありとみなす。
  if (!codex || (codex.projected ?? 0) > 100 || (codex.primaryPct ?? 0) >= CODEX_PRIMARY_LIMIT) return '';

  const fmt = (n) => `${Math.round(n)}%`;
  const codexText = codex.projected === null ? `${codex.pct}%、週の頭で判定不可` : `着地見込み ${fmt(codex.projected)}`;
  return [
    '# 週次枠のペース（再起動の時点）',
    '',
    `- Claude の週次枠がハイペース（${claude.pct}%、リセット時の着地見込み ${fmt(claude.projected)}）で、Codex には余裕がある（${codexText}）。`,
    '- 判断の質が落ちにくい作業（コードレビュー・機械的な変換や置き換え・文書のチェックなど）は、自分でやらず Codex に回す。Codex に任せる手順（スキルなど）を持っていれば、それに従う。',
    '- 実装の主担当を丸ごと移すような大きな切り替えは、ユーザーに一声かけてから。',
  ].join('\n');
}
