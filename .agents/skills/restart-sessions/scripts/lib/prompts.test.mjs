// node --test lib/prompts.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { attachGuide, GUIDE_SEPARATOR, idleClearPrompt, SKILL_DIR, WITH_GUIDE_SUFFIX } from './prompts.mjs';

const exitSelf = `${SKILL_DIR}/exit-self.md`;

test('進め方をつないだファイルは、仕事を終えていれば exit-self.md で終わる手順を、置き場の絶対パスで持つ', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-test-'));
  try {
    const handoff = path.join(dir, 'handoff.md');
    fs.writeFileSync(handoff, '# 状態メモ\n\n仕事は済んだ。\n', 'utf8');
    const { path: sent, error } = attachGuide(handoff, '一文', '# 先の節');
    assert.equal(error, '');
    assert.equal(sent, path.join(dir, `handoff${WITH_GUIDE_SUFFIX}`));
    const text = fs.readFileSync(sent, 'utf8');
    assert.ok(text.startsWith('# 先の節\n\n# 再起動した先の進め方'));
    assert.ok(text.includes(`\`${exitSelf}\` に従って`));
    assert.ok(text.includes(`${SKILL_DIR}/scripts/exit-self.mjs`));
    assert.ok(!text.includes('<skill-dir>'));
    assert.ok(text.endsWith(`一文${GUIDE_SEPARATOR}# 状態メモ\n\n仕事は済んだ。\n`));
    assert.equal(fs.readFileSync(handoff, 'utf8'), '# 状態メモ\n\n仕事は済んだ。\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('置き場の exit-self.md とスクリプトは実在する', () => {
  assert.ok(fs.existsSync(exitSelf));
  assert.ok(fs.existsSync(`${SKILL_DIR}/scripts/exit-self.mjs`));
  assert.ok(!SKILL_DIR.includes('\\'));
});

test('/clear の後の1行のプロンプトは、仕事を終えていれば exit-self.md で終わらせる。シェルが残るときは終わらせず、続けてよいと足す', () => {
  const plain = idleClearPrompt('/tmp/idle.md');
  assert.ok(plain.startsWith('@/tmp/idle.md '));
  assert.ok(plain.includes(`\`${exitSelf}\` に従って終わって`));
  assert.ok(!plain.includes('<skill-dir>'));
  assert.ok(!plain.includes('\n'));
  assert.ok(!plain.includes('バックグラウンドのシェル'));
  const shells = idleClearPrompt('/tmp/idle.md', true);
  assert.ok(!shells.includes('exit-self'));
  assert.ok(!shells.includes('\n'));
  assert.ok(shells.endsWith('会話ログにある予定に沿って続けてかまいません。'));
});
