// node --test lib/exit.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { exitLogLine, isHubCwd, parseExitArgs, sendMessageProblem } from './exit.mjs';

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

// 会話ログの行の形は 2.1.332 の JSONL で実測（2026-11-25 に返信が届かなかったセッションのもの）。
const use = (id, to, msg = `m-${id}`) => JSON.stringify({ type: 'assistant', message: { id: msg, content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to, message: 'x' } }] } });
const result = (id, body) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: typeof body === 'string' ? body : JSON.stringify(body) }] } });
const bash = (msg) => JSON.stringify({ type: 'assistant', message: { id: msg, content: [{ type: 'tool_use', id: `b-${msg}`, name: 'Bash', input: {} }] } });
const other = bash('m-other');

test('SendMessage を使っていなければ止めない', () => {
  assert.equal(sendMessageProblem([other, 'not json', '']), null);
});

test('同じ手番に並べて結果がまだ無ければ、「返信は未達」でも止める', () => {
  assert.match(sendMessageProblem([use('s1', 'rencon-d6', 'm1'), bash('m1')], '返信は未達'), /結果がまだ会話ログに無い/);
});

test('前の手番の SendMessage に結果が残っていなければ、「返信は未達」と書けば通す', () => {
  const lines = [use('s1', 'rencon-d6', 'm1'), bash('m2')];
  assert.match(sendMessageProblem(lines, '済み'), /結果が会話ログに残っていない/);
  assert.equal(sendMessageProblem(lines, '済み。返信は未達'), null);
});

test('success:false なら止め、送り直して届けば止めない', () => {
  const refused = { success: false, message: "No agent is named 'rencon-d6' exactly. Re-send with the ref" };
  assert.match(sendMessageProblem([use('s1', 'rencon-d6'), result('s1', refused)]), /届いていない.*Re-send with the ref/);
  const ok = { success: true, message: '"x" → rencon-d6/mac (a Claude session on another machine, over Remote Control; not confirmed read)' };
  assert.equal(sendMessageProblem([use('s1', 'rencon-d6'), result('s1', refused), use('s2', 'rencon-d6/mac [b33426]'), result('s2', ok)]), null);
});

test('queued のときは、要約に「返信は未達」とあれば止めない。題や宛名の語では queued と見ない', () => {
  const queued = { success: true, message: 'not confirmed read; it is offline right now — delivery is queued until that machine reconnects' };
  const lines = [use('s1', 'rencon-63/mac'), result('s1', queued)];
  assert.match(sendMessageProblem(lines, '確かめを終えた'), /queued/);
  assert.equal(sendMessageProblem(lines, '確かめを終えた。返信は未達のおそれ（queued）'), null);
  // 題に queued の語があっても、届いていれば止めない。
  const delivered = { success: true, message: '"merge queued" → rencon-d6/mac (a Claude session on another machine, over Remote Control; not confirmed read)' };
  assert.equal(sendMessageProblem([use('s1', 'rencon-d6/mac'), result('s1', delivered)], '済み'), null);
  const named = { success: true, message: '"offline migration" → offline-bot/mac (a Claude session on another machine, over Remote Control; not confirmed read)' };
  assert.equal(sendMessageProblem([use('s1', 'offline-bot/mac'), result('s1', named)], '済み'), null);
});

test('結果の形が読めないとき（JSON でない・配列の text）は止めない', () => {
  assert.equal(sendMessageProblem([use('s1', 'a'), result('s1', 'sent')]), null);
  const arrayContent = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'no' }) }] }] } });
  assert.match(sendMessageProblem([use('s1', 'a'), arrayContent]), /届いていない/);
});

test('会話でない行（api-request-blob）に写った同じ tool_use は数えない', () => {
  const blob = JSON.stringify({ type: 'api-request-blob', message: { content: [{ type: 'tool_use', id: 's1', name: 'SendMessage', input: { to: 'a' } }] } });
  assert.equal(sendMessageProblem([use('s1', 'a'), result('s1', { success: true, message: 'sent' }), blob]), null);
});

test('送り直せない失敗は、要約に「返信は未達」と書けば通す（「未達成」では通さない）。結果がまだ無いときは通さない', () => {
  const refused = [use('s1', 'a'), result('s1', { success: false, message: 'no' })];
  assert.match(sendMessageProblem(refused, '済み'), /未達/);
  assert.equal(sendMessageProblem(refused, '済み。返信は未達（相手が終わっていた）'), null);
  assert.match(sendMessageProblem(refused, '目標は未達成'), /届いていない/);
  assert.match(sendMessageProblem([use('s1', 'a', 'm1'), bash('m1')], '返信は未達'), /結果がまだ会話ログに無い/);
});

test('is_error の結果は失敗として扱い、サブエージェントの行は数えない', () => {
  const errored = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', is_error: true, content: 'Error: denied' }] } });
  assert.match(sendMessageProblem([use('s1', 'a'), errored]), /届いていない（Error: denied）/);
  const side = JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id: 'x1', name: 'SendMessage', input: { to: 'b' } }] } });
  assert.equal(sendMessageProblem([use('s1', 'a'), result('s1', { success: true, message: 'sent' }), side]), null);
});

test('手番は message.id が両方あるときだけ分ける。同じ手番の2通目に結果が無ければ止める', () => {
  const noId = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } });
  assert.match(sendMessageProblem([use('s1', 'a', 'm1'), noId], '返信は未達'), /結果がまだ会話ログに無い/);
  const lines = [use('s1', 'a', 'm1'), result('s1', { success: true, message: 'sent' }), use('s2', 'b', 'm1'), bash('m1')];
  assert.match(sendMessageProblem(lines, '返信は未達'), /宛先 b）の結果がまだ会話ログに無い/);
});
