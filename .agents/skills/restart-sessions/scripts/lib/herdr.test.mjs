// node --test lib/herdr.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftIsRequest } from './herdr.mjs';

const request = '@/tmp/handoff-with-guide.md このセッション自身の再起動です。資料の先頭の「自己再起動の手順」に従うこと。';

test('入力欄に残った依頼は、折り返して改行や字下げが入っても依頼と見る', () => {
  assert.ok(draftIsRequest(request, request));
  assert.ok(draftIsRequest('@/tmp/handoff-with-guide.md このセッション自身の再起動です。資料の先頭の「自己再起動の手順」\n  に従うこと。', request));
});

test('空の入力欄・依頼と違う文は依頼と見ない', () => {
  assert.equal(draftIsRequest('', request), false);
  assert.equal(draftIsRequest(null, request), false);
  assert.equal(draftIsRequest('別の書きかけ', request), false);
  assert.equal(draftIsRequest('@/tmp/handoff-with-guide.md', request), false);
  assert.equal(draftIsRequest('に従うこと。', request), false);
});
