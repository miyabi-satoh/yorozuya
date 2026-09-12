// 引き継ぎ資料のパスの検証。2つのスクリプトが同じことを確かめるので、ここ1つに置く。

import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// 問題があればその文を返す。無ければ空文字列。
// whose は「対象のペイン」「新セッション」など、そのパスを解決する側の呼び名。
export function handoffProblem(handoff, whose) {
  // startsWith('/') では Windows の絶対パス（C:\...）を絶対と見なせない。
  // ペインの cwd 側は isAbsolute で見ているので、判定をそちらに揃える。
  if (!isAbsolute(handoff)) {
    return `資料は絶対パスで渡すこと。${whose}の cwd で解決されるため: ${handoff}`;
  }
  // 存在の確認と種類の確認を stat 1回で済ませる。existsSync の後に statSync を呼ぶと、その間に
  // 消されたとき例外で案内なしに落ちる。stat の失敗は「無い」として扱う。
  // ディレクトリや FIFO も存在はするが、@ 参照で読めないまま再起動が進むので、通常のファイルに限る。
  let stat;
  try {
    stat = statSync(handoff);
  } catch {
    return `資料が無い: ${handoff}`;
  }
  if (!stat.isFile()) return `資料が通常のファイルではない: ${handoff}`;
  // @ 参照は空白で切れる。渡す前に分かるので、ここで止める。
  if (handoff.includes(' ')) return `資料のパスに空白が入っている。@ 参照が途中で切れる: ${handoff}`;
  return '';
}
