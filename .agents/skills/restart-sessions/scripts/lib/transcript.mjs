// 会話の記録（~/.claude/projects/<プロジェクト>/<セッションID>.jsonl）を探す。
// セッションIDは UUID で衝突しないので、プロジェクトのフォルダー名の作り方（cwd のどの文字を置き換えるか）を当てにせず、全部のフォルダーから探す。

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const projectsDir = (home = homedir()) => join(home, '.claude', 'projects');

// そのセッションの記録のパスを、見つかった分だけ返す。projects のフォルダーを読めなければ投げる（無いのと読めないのを、呼び出し側が分けられるように）。
export function transcriptsOf(sessionId, home = homedir()) {
  const dir = projectsDir(home);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name, `${sessionId}.jsonl`))
    .filter((file) => existsSync(file));
}
