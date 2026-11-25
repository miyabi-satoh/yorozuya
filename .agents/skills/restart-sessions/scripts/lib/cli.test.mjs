// node --test lib/cli.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { takeFlag } from './cli.mjs';

test('takeFlag は flag をどこに置いても抜き出し、残りの順を保つ', () => {
  assert.deepEqual(takeFlag(['a', '--allow-background', 'b'], '--allow-background'), { on: true, rest: ['a', 'b'] });
  assert.deepEqual(takeFlag(['a', 'b'], '--allow-background'), { on: false, rest: ['a', 'b'] });
});

test('reporter の skip・fail は、片付けを流してから接頭辞つきで書き、終了コード 1 で止まる', () => {
  const url = new URL('./cli.mjs', import.meta.url).href;
  for (const kind of ['skip', 'fail']) {
    const code = `const { reporter } = await import(${JSON.stringify(url)}); const r = reporter('x', () => r.log('片付け')); r.log('前'); r.${kind}('理由'); r.log('届かない');`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.equal(run.stderr, `[x] 前\n[x] 片付け\n[x] ${kind.toUpperCase()}: 理由\n`);
  }
});
