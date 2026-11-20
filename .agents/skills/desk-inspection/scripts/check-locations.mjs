#!/usr/bin/env node
// レポートの <code>path:line</code> が、検査したリポジトリの今のファイルに実在するかを見る。
// 使い方: node check-locations.mjs <report.html> <repo のルート>
// 終了コード: 0 = 通った / 1 = 行がファイルの長さを超える場所がある（書き間違いか、別の版を読んだ）/
//   2 = 確かめられなかった（引数・読めないファイル・1か所も確かめられなかった）。1 と分けるのは、確かめられないまま通ったと読まないため。
// リポジトリに無いパス（依存のソースなど）と、名前だけで複数のファイルに当たるものは、確かめられなかったとして並べるだけにする。
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [reportPath, repo] = process.argv.slice(2);
if (!reportPath || !repo) {
  console.error("usage: node check-locations.mjs <report.html> <repo root>");
  process.exit(2);
}

const fail = (msg) => {
  console.error(msg);
  process.exit(2);
};
let html;
let files;
try {
  // コメントの中（ひな形の例など）は場所として読まない。
  html = readFileSync(reportPath, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  // -z: 既定では日本語のパスが引用符と8進のエスケープで出て、レポートの書き方と合わなくなる。
  files = execFileSync("git", ["-C", repo, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
} catch (e) {
  fail(`読めなかった: ${e.message}`);
}
const fileSet = new Set(files);

const decode = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ");

// 「<code>a.rs:10</code>・<code>:20</code>」のように、行だけの書き方は直前のパスを引き継ぐ。
// 引き継ぐのは同じ段落（dd・li）の中だけにする。
const blocks = html.split(/<\/(?:dd|li)>/);
const lineCount = new Map();
// 読めないもの（作業フォルダで消したファイル・ディレクトリ・サブモジュール）は null。
const countLines = (f) => {
  if (!lineCount.has(f)) {
    let n = null;
    try {
      const p = join(repo, f);
      if (statSync(p).isFile()) {
        const text = readFileSync(p, "utf8");
        n = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      }
    } catch {}
    lineCount.set(f, n);
  }
  return lineCount.get(f);
};
const resolve = (p) => {
  const clean = p.replace(/^\.\//, "");
  if (fileSet.has(clean)) return [clean];
  return files.filter((f) => f === clean || f.endsWith(`/${clean}`));
};

let bad = 0;
let ok = 0;
const unresolved = [];
for (const block of blocks) {
  let prev = null;
  for (const m of block.matchAll(/<code>([^<]+)<\/code>/g)) {
    const text = decode(m[1]).trim();
    const loc = text.match(/^(.*?):(\d+)(?:-(\d+))?$/);
    if (!loc) continue;
    let [, path, from, to] = loc;
    if (path === "") {
      if (!prev) continue;
      path = prev;
    } else if (!/[./]/.test(path) && !files.some((f) => f === path || f.endsWith(`/${path}`))) {
      continue; // パスでない（「UNIQUE constraint failed: …」など）。拡張子の無いファイル（Makefile など）は通す
    }
    const shown = text.startsWith(":") ? `${path}${text}` : text;
    const hits = resolve(path);
    if (hits.length !== 1) {
      unresolved.push(`${shown}${hits.length > 1 ? ` (候補 ${hits.length} 件)` : ""}`);
      prev = path;
      continue;
    }
    prev = path;
    const last = Number(to ?? from);
    const n = countLines(hits[0]);
    if (n === null) {
      unresolved.push(`${shown} (読めない)`);
      continue;
    }
    if (Number(from) < 1 || last > n) {
      console.log(`NG  ${shown} → ${hits[0]} は ${n} 行`);
      bad++;
    } else {
      ok++;
    }
  }
}

console.log(`確かめた場所: ${ok + bad} 件 (NG ${bad} 件)`);
if (ok + bad === 0) fail("1か所も確かめられなかった。リポジトリのルートと、レポートの場所の書き方（リポジトリからの相対パス）を見直す");
if (unresolved.length) {
  console.log(`リポジトリで確かめられなかった場所 (依存のソースなら、そのまま): ${unresolved.length} 件`);
  for (const u of [...new Set(unresolved)]) console.log(`  ${u}`);
}
process.exit(bad ? 1 : 0);
