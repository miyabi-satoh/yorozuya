// node --test lib/exit.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { exitLogLine, isHubCwd, parseExitArgs } from './exit.mjs';

test('引数は --allow-background と要約。要約が空なら null', () => {
  assert.deepEqual(parseExitArgs(['PR #12 をマージ', '済み']), { allowBackground: false, summary: 'PR #12 をマージ 済み' });
  assert.deepEqual(parseExitArgs(['--allow-background', 'x']), { allowBackground: true, summary: 'x' });
  assert.equal(parseExitArgs([]), null);
  assert.equal(parseExitArgs(['--allow-background', '  ']), null);
});

test('記録の1行は TSV（時刻・端末名・cwd・セッションID・要約）で、タブと改行は空白にする', () => {
  const line = exitLogLine({ time: new Date('2026-11-25T01:02:03.000Z'), name: 'knowledge-4b', cwd: '/w', sid: 'abc', summary: '調査\tを終えた\n報告済み' });
  assert.equal(line, '2026-11-25T01:02:03.000Z\tknowledge-4b\t/w\tabc\t調査 を終えた 報告済み\n');
  assert.equal(line.trimEnd().split('\t').length, 5);
});

test('hub の cwd（と配下）は自分で終わらない。ほかは終わってよい', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-test-'));
  fs.mkdirSync(path.join(home, 'Projects', 'hub', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Projects', 'hub2'), { recursive: true });
  try {
    assert.equal(isHubCwd(path.join(home, 'Projects', 'hub'), home), true);
    assert.equal(isHubCwd(path.join(home, 'Projects', 'hub', 'sub'), home), true);
    assert.equal(isHubCwd(path.join(home, 'Projects', 'hub2'), home), false);
    assert.equal(isHubCwd(path.join(home, 'Projects', 'knowledge'), home), false);
    assert.equal(isHubCwd('', home), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
