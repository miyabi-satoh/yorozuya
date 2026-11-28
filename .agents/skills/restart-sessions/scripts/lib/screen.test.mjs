import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dialogOpen } from './screen.mjs';

test('画面末尾の選択式の問いを検出する', () => {
  assert.equal(dialogOpen('質問\nEnter to select · Esc to cancel\n────\n'), true);
  assert.equal(dialogOpen('Esc to cancel\n会話\n入力欄\n下枠\n状態'), false);
  assert.equal(dialogOpen(null), false);
});
