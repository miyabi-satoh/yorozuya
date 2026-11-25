// node --test lib/prompts.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  attachGuide,
  GUIDE_SEPARATOR,
  idleClearPrompt,
  restartRequest,
  selfRestartRequest,
  selfRestartSteps,
  SKILL_DIR,
  WITH_GUIDE_SUFFIX,
} from './prompts.mjs';

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
  assert.ok(plain.includes(`「${exitSelf}」に従って終わって`));
  assert.ok(!plain.includes('`'));
  assert.ok(!plain.includes('<skill-dir>'));
  assert.ok(!plain.includes('\n'));
  assert.ok(!plain.includes('バックグラウンドのシェル'));
  const shells = idleClearPrompt('/tmp/idle.md', true);
  assert.ok(!shells.includes('exit-self'));
  assert.ok(!shells.includes('\n'));
  assert.ok(shells.endsWith('会話ログにある予定に沿って続けてかまいません。'));
});

test('自己再起動の手順の節は、hc と Herdr で前セッションの呼び方と閉じ方だけが違う', () => {
  assert.equal(
    selfRestartSteps({ where: 'hc の端末 t7', sid: 'abc', close: "'hc kill t7' のあと 'hc rm t7' で前セッションの端末を閉じる", old: '旧の端末' }),
    `# 自己再起動の手順

このセッション自身の再起動。前セッション（hc の端末 t7 / セッション abc）は資料を書き終えて、閉じられるのを待っている。

1. この資料を読んで現状を把握する。
2. 把握できたら 'hc kill t7' のあと 'hc rm t7' で前セッションの端末を閉じる。閉じると前セッションは強制終了になる（資料は書けているので問題ない。戻りたくなったら 'claude --resume abc'）。読み終える前に閉じないこと。
3. ユーザーに再起動の結果を報告し、下の「再起動した先の進め方」に従って引き継ぐ。

1 と 2 は確認を挟まずに進める。3 は、どれも（処理の立ち上げ直しも、作業の再開も、問いの出し直しや状態を聞く問いも）旧の端末を閉じてから行う。先に問いを出すと、答えを待つ間ずっと旧の端末が残る。`,
  );
  assert.equal(
    selfRestartSteps({ where: 'ペイン p1', sid: 'abc', close: "'herdr pane close p1' で前セッションのペインを閉じる", old: '旧ペイン' }),
    `# 自己再起動の手順

このセッション自身の再起動。前セッション（ペイン p1 / セッション abc）は資料を書き終えて、閉じられるのを待っている。

1. この資料を読んで現状を把握する。
2. 把握できたら 'herdr pane close p1' で前セッションのペインを閉じる。閉じると前セッションは強制終了になる（資料は書けているので問題ない。戻りたくなったら 'claude --resume abc'）。読み終える前に閉じないこと。
3. ユーザーに再起動の結果を報告し、下の「再起動した先の進め方」に従って引き継ぐ。

1 と 2 は確認を挟まずに進める。3 は、どれも（処理の立ち上げ直しも、作業の再開も、問いの出し直しや状態を聞く問いも）旧ペインを閉じてから行う。先に問いを出すと、答えを待つ間ずっと旧ペインが残る。`,
  );
});

test('新セッションへの依頼は、つないだファイルを指す1行', () => {
  assert.equal(restartRequest('/tmp/a-with-guide.md'), '@/tmp/a-with-guide.md 前セッションの引き継ぎ資料です。資料の先頭の「再起動した先の進め方」に従って引き継ぐこと。');
  assert.equal(selfRestartRequest('/tmp/a-with-guide.md'), '@/tmp/a-with-guide.md このセッション自身の再起動です。資料の先頭の「自己再起動の手順」に従うこと。');
});
