import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handoffProblem } from './handoff.mjs';

test('空白を含む資料のパスは存在していても渡せない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-test-'));
  try {
    const file = join(dir, 'with space.md');
    writeFileSync(file, '資料');
    assert.match(handoffProblem(file, '自分のペイン'), /パスに空白/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
