import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { transcriptsOf } from './transcript.mjs';

test('会話の記録は、どのプロジェクトのフォルダーにあっても探す。projects を読めなければ投げる', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.throws(() => transcriptsOf('s1', home));
  const projects = path.join(home, '.claude', 'projects');
  for (const name of ['a', 'b']) fs.mkdirSync(path.join(projects, name), { recursive: true });
  fs.writeFileSync(path.join(projects, 'b', 's1.jsonl'), '');
  fs.writeFileSync(path.join(projects, 's1.jsonl'), '');
  assert.deepEqual(transcriptsOf('s1', home), [path.join(projects, 'b', 's1.jsonl')]);
  assert.deepEqual(transcriptsOf('s2', home), []);
});
