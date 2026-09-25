// 再起動した新セッションに、最初のプロンプトで渡す進め方。2つのスクリプトが同じことをするので、ここ1つに置く。
//
// 進め方の本文は after-restart.md に置き、スクリプトが資料の先頭に書き足す。プロンプトはそれを指す1行にする。
// - 本文をプロンプトに直に入れると、ペインの入力欄と会話に毎回長い文が出る。
// - スキルの中を読めと書くだけでは足りない。再起動する先の多くは他のプロジェクトのセッションで、このスキルを持っていない。
// - 本文を2つ目の `@` 参照で添えたら、依頼が送信されずに入力欄に残り、Enter を送っても効かなかった
//   （notes/2026-09-17-restart-prompt-not-submitted.md の 2026-09-25 追記）。`@` は資料の1つだけにする。
//
// 本文の決めごとの理由:
// - 再起動はコンテキストを入れ替えるもので、セッションがしていたことは変えない。進めていたなら続きから進め、答えを待っていたなら同じ問いで待つ。
//   以前は、再起動した先に進め方の二択を出させていた。再起動のたびに答える手間が重く、再起動したことは呼び出し元か新セッションが報告すれば足りるので、やめた。
// - 問いは前と同じ形で出し直させる。テキストの問いをダイアログに変えると、ペインが blocked になり、見張りも次の依頼も届かなくなる。
// - バックグラウンドの処理は再起動で止まるので、資料に書かれた手順で立ち上げ直させる。
// - 会話ログは今の会話の範囲にとどまるので、プロジェクトの大きな流れは別の置き場にある。資料が指していれば、続ける前に読ませる。
// - 会話で決めた計画（A〜E を順に進める、など）は、一部の途中で再起動しても残りへ進ませる。要約をやめて会話ログを写すのもこのため。
// - 状態は資料から読ませる。資料の状態メモは手順2の返信（自己再起動では自分）で書かれ、続く会話ログは発言の写し。
// - 会話ログの末尾には再起動の依頼と返信が残るので、済んだものとして扱わせる。
// - 承認は資料では運べないので、後戻りできない操作と外向きの操作は、新セッションが確かめ直す。
//   ユーザーが記憶や CLAUDE.md で前もって決めた扱いは、新セッションにもそのまま見えるので、それに従わせる。
//   ただし記憶は旧セッションも書けるので、個々の操作を承認済みとした記録は、前もって決めた扱いに数えない。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GUIDE = fileURLToPath(new URL('../../after-restart.md', import.meta.url));

export const HOW_TO_PROCEED = '資料の先頭の「再起動した先の進め方」に従って引き継ぐこと。';

// 資料の先頭に進め方を書き足す。すでに書き足してあれば（呼び直したとき）そのまま。
// 失敗したらその理由を、うまくいけば空文字列を返す。
export function attachGuide(handoff) {
  let guide;
  let body;
  try {
    guide = readFileSync(GUIDE, 'utf8').trimEnd();
    body = readFileSync(handoff, 'utf8');
  } catch (error) {
    return `進め方か資料を読めない: ${error.message}`;
  }
  if (body.startsWith(guide)) return '';
  // 前に書き足した進め方が先頭に残っていれば（呼び直すまでに after-restart.md が変わったなど）、差し替える。
  // 見るのは先頭だけ。会話ログの中に同じ見出しが出てきても触らない。
  const heading = guide.split('\n', 1)[0];
  const separator = '\n\n---\n\n';
  if (body.startsWith(`${heading}\n`) && body.includes(separator)) {
    body = body.slice(body.indexOf(separator) + separator.length);
  }
  try {
    writeFileSync(handoff, `${guide}${separator}${body}`, 'utf8');
  } catch (error) {
    return `資料に進め方を書き足せない: ${error.message}`;
  }
  return '';
}
