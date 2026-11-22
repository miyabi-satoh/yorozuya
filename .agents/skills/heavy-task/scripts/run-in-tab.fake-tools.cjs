// run-in-tab.test.mjs の、hc・herdr の偽物。タブの動きだけを真似る。
// テストは node の実体を bin/hc・bin/herdr（Windows は .exe）として張り、NODE_OPTIONS の --require でこのファイルを読ませる。
// sh のスクリプトの偽物は Windows では起動できず、PATH の後ろの本物の hc・herdr が呼ばれてしまうため、node そのものを偽物にする。
// 偽物の名前で起動されたときだけ動き、ほかの node（テスト・run-in-tab.mjs・runner）では何もしない。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const tool = path.basename(process.execPath).replace(/\.exe$/i, '');
const state = process.env.FAKE_TOOLS_STATE;
if ((tool === 'hc' || tool === 'herdr') && state) {
  // node は最初の引数をスクリプトの名前とみて、process.argv[1] を今の場所からの絶対パスにする。偽物の最初の引数（サブコマンド）は、その名前の部分。
  const args = [path.basename(process.argv[1]), ...process.argv.slice(2)];
  const mark = (name) => path.join(state, name);
  // 後ろで流すものは、偽物が返った後も動き続けるよう切り離す。本物も送ったらすぐ返る。
  const background = (command, argv, touchWhenDone) => {
    const waiter = `const { spawnSync } = require('node:child_process'); const fs = require('node:fs');` +
      `const [cmd, done, ...argv] = JSON.parse(process.argv[1]);` +
      `spawnSync(cmd, argv, { stdio: 'ignore', shell: argv.length === 0, windowsHide: true });` +
      `if (done) fs.writeFileSync(done, '');`;
    spawn(process.env.FAKE_TOOLS_NODE, ['-e', waiter, JSON.stringify([command, touchWhenDone ?? '', ...argv])], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  };
  if (tool === 'herdr') {
    const [a, b] = args;
    if (a === 'tab' && b === 'create') {
      fs.writeFileSync(mark('create-args'), `${args.join('\n')}\n`);
      console.log('{"result":{"root_pane":{"pane_id":"w1:p1"},"tab":{"tab_id":"w1:t1"}}}');
    } else if (a === 'pane' && b === 'run') {
      if (!fs.existsSync(mark('no-run'))) background(args[3], []);
    } else if (a === 'pane' && b === 'get') {
      if (fs.existsSync(mark('gone'))) {
        console.log('{"error":{"code":"pane_not_found"}}');
        process.exit(1);
      }
    } else if (a === 'pane' && b === 'read') {
      console.log('screen');
    } else if (a === 'tab' && b === 'close') {
      fs.writeFileSync(mark('closed'), '');
    }
    process.exit(0);
  }
  // hc。出力の形は hc 0.1.21 の --json に合わせる（成功は stdout、失敗は stderr の {"error":{"kind"}}）。
  const [sub, ...rest] = args;
  fs.appendFileSync(mark('calls'), `${[sub, ...rest].join(' ')}\n`);
  const fail = (kind, message, code) => {
    console.error(JSON.stringify({ error: { kind, message } }));
    process.exit(code);
  };
  if (sub === 'run') {
    const dash = rest.indexOf('--');
    const options = rest.slice(0, dash);
    const name = options.includes('--name') ? options[options.indexOf('--name') + 1] : '';
    if (fs.existsSync(mark(`taken-${name}`))) fail('name_taken', 'taken', 1);
    // run は -- の後の argv を後ろで流し、終わったら finished にする。
    if (!fs.existsSync(mark('no-run'))) background(rest[dash + 1], rest.slice(dash + 2), mark('finished'));
    else fs.writeFileSync(mark('finished'), '');
    console.log(JSON.stringify({ address: 't9', name, state: 'live' }));
  } else if (sub === 'get') {
    if (fs.existsSync(mark('gone'))) fail('not_found', 'no terminal', 3);
    console.log(JSON.stringify({ address: 't9', state: fs.existsSync(mark('finished')) ? 'finished' : 'live' }));
  } else if (sub === 'read') {
    console.log('{"text":"screen","complete":true,"how":"screen"}');
  } else if (sub === 'kill') {
    fs.writeFileSync(mark('killed'), '');
    console.log('{"address":"t9","state":"finished"}');
  } else if (sub === 'rm') {
    fs.writeFileSync(mark('closed'), '');
    console.log('{"removed":"t9"}');
  }
  process.exit(0);
}
