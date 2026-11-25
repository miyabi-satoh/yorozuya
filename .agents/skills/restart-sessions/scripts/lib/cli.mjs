// スクリプトの引数と止まり方の決まり。どのスクリプトも同じ形で SKIP・FAIL を出すので、ここ1つに置く。

// 引数から flag を抜き出す。返すのは { on: 付いていたか, rest: flag を除いた残り }。
export function takeFlag(args, flag) {
  return { on: args.includes(flag), rest: args.filter((arg) => arg !== flag) };
}

// `[<prefix>] …` の形で stderr に書く log と、止まる skip・fail を作る。どちらも終了コードは 1 で、接頭辞（SKIP・FAIL）で見分ける。
// before は止まる前に流す片付け（無ければ何もしない）。
export function reporter(prefix, before = () => {}) {
  const write = (message) => process.stderr.write(`[${prefix}] ${message}\n`);
  const stop = (kind) => (message) => {
    before();
    write(`${kind}: ${message}`);
    process.exit(1);
  };
  return { log: write, skip: stop('SKIP'), fail: stop('FAIL') };
}
