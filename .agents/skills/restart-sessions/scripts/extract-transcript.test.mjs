import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./extract-transcript.mjs', import.meta.url));
const sid = '01234567-89ab-cdef-0123-456789abcdef';
function extract(records) {
  const home = mkdtempSync(join(tmpdir(), 'transcript-test-'));
  try {
    const dir = join(home, '.claude', 'projects', 'project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sid}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n'));
    return execFileSync(process.execPath, [script, sid], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  } finally { rmSync(home, { recursive: true, force: true }); }
}
const record = (type, content) => ({ type, message: { content } });

test('選択式の問いと対応する回答を順に残し、他のツールは落とす', () => {
  const output = extract([
    record('assistant', [{ type: 'text', text: '最初' }, { type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: '進めますか？', options: [{ label: 'はい' }, { label: 'いいえ' }] }] } }, { type: 'tool_use', id: 'b1', name: 'Bash', input: {} }]),
    record('user', [{ type: 'tool_result', tool_use_id: 'b1', content: '除外' }, { type: 'tool_result', tool_use_id: 'q1', content: 'The user answered: "進めますか？"="はい"' }]),
    record('assistant', [{ type: 'tool_use', id: 'q2', name: 'AskUserQuestion', input: { questions: [{ question: '次は？', options: [] }] } }]),
    record('user', [{ type: 'tool_result', tool_use_id: 'q2', is_error: true, content: 'User rejected the request' }]),
  ]);
  assert.match(output, /最初[\s\S]*進めますか？\n- はい\n- いいえ[\s\S]*The user answered:[\s\S]*次は？[\s\S]*User rejected/);
  assert.doesNotMatch(output, /除外/);
});

test('Windows の絶対パスの前の資料を認識する', () => {
  for (const path of ['C:\\missing\\handoff.md', 'C:/missing/handoff.md']) {
    const output = extract([record('user', `@${path} 前セッションの引き継ぎ資料です`)]);
    assert.ok(output.includes(`最初の発言で読んでいた ${path} は、もう無かった`));
  }
});
