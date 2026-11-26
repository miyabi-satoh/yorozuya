// shebang で始まるファイルが、git に実行権限（100755）付きで入っているかを確かめる。見るのは index。
// 手順やコードがスクリプトをパスで直接実行するので、権限が無いと exit 126 になる。
// ADR: 呼び方を文書から拾わず shebang で決める。呼び方は書き方がまちまちで、拾い漏らすため。
import { spawnSync } from 'node:child_process';

function git(...args) {
  const run = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // git grep は、当たりが無いと 1 で終わる。
  if (run.status === 0 || (args[0] === 'grep' && run.status === 1)) return run.stdout;
  throw new Error(`git ${args[0]} が失敗した: ${run.error?.message ?? run.stderr}`);
}

// -z -n の1件は「パス NUL 行番号 NUL 行の中身 LF」。
const shebang = new Set(
  [...git('grep', '--cached', '--full-name', '-I', '-n', '-z', '-e', '^#!', '--', ':/').matchAll(/([^\0]+)\0(\d+)\0[^\n]*\n/g)]
    .filter(([, , line]) => line === '1')
    .map(([, path]) => path),
);

const missing = git('ls-files', '-s', '-z', '--full-name', '--', ':/')
  .split('\0')
  .filter((entry) => entry.startsWith('100644 '))
  .map((entry) => entry.slice(entry.indexOf('\t') + 1))
  .filter((path) => shebang.has(path));

if (missing.length > 0) {
  console.error('shebang があるのに実行権限が無い（どの OS でも、下を流せば直る）:');
  for (const path of missing) console.error(`  git update-index --chmod=+x '${path}'`);
  process.exit(1);
}
