// node --test lib/orca.test.mjs
// Orca の CLI の出力の読み方を、実測した出力の形（Orca 1.4.268）で確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  agentStateOf,
  claudeTerminalsFrom,
  draftFromRead,
  parseOrcaOutput,
  screenFromRead,
  sendStarted,
  sessionForTitle,
  sessionsForTitle,
  claudePidsFromPs,
  sameDir,
  stripTitle,
  submittedOnScreen,
} from './orca.mjs';

const border = '─'.repeat(40);
// 入力欄の上枠の右端にセッションの名前が載る。下枠の下はステータスラインとモードライン。
const screen = (input, above = ['⏺ ok']) => [...above, `${'─'.repeat(30)} knowledge-10/mac ─`, `❯ ${input}`.trimEnd(), border, '  Model: Opus 5.5 | Ctx Used: 28.0%', '  ⏵⏵ auto mode on'];
const read = (tail, extra = {}) => ({ terminal: { handle: 'term_1', status: 'running', tail, source: 'screen', ...extra } });

test('失敗も JSON で stdout に出るので、中身を読む', () => {
  assert.deepEqual(parseOrcaOutput('{"ok":false,"error":{"code":"terminal_handle_stale"}}'), { ok: false, error: { code: 'terminal_handle_stale' } });
  assert.equal(parseOrcaOutput('not json'), null);
});

test('画面は tail をつなぎ、ノーブレークスペースを普通の空白にする。描けなかった画面は読めない扱い', () => {
  assert.equal(screenFromRead(read(['a\u00a0b', 'c'])), 'a b\nc');
  assert.equal(screenFromRead(read(['a'], { source: 'screen-unavailable' })), null);
  assert.equal(screenFromRead(read(['a'], { source: undefined })), 'a');
  assert.equal(screenFromRead({}), null);
});

test('書きかけは draft から読む。Orca は書きかけを画面から外して draft に分ける', () => {
  assert.equal(draftFromRead(read(screen(''), { draft: 'some draft' })), 'some draft');
  assert.equal(draftFromRead(read(screen(''))), '');
});

test('draft が無くても、画面の入力欄に文があれば書きかけと見る。案内の薄字（Try "…"）は空とみなす', () => {
  assert.equal(draftFromRead(read(screen('打ちかけ'))), '打ちかけ');
  assert.equal(draftFromRead(read(screen('Try "create a util logging.py that…"'))), '');
  // 入力欄の枠が無い画面は、書きかけがあるか分からない。
  assert.equal(draftFromRead(read(['シェルの画面'])), null);
});

test('タイトルの頭の状態の印は、知っている印だけを外す', () => {
  assert.equal(stripTitle('✳ _wip/mac'), '_wip/mac');
  assert.equal(stripTitle('#12-x'), '#12-x');
  assert.equal(stripTitle('✳ weblav-5d/mac'), 'weblav-5d/mac');
  assert.equal(stripTitle('◐ knowledge-10/mac'), 'knowledge-10/mac');
  assert.equal(stripTitle('clipkeep-2c/mac'), 'clipkeep-2c/mac');
  assert.equal(stripTitle(null), '');
});

const sessions = [
  { pid: 1, sessionId: 's-k10', name: 'knowledge-10/mac', cwd: '/p/knowledge' },
  { pid: 2, sessionId: 's-k1', name: 'knowledge-1', cwd: '/p/knowledge' },
  { pid: 3, sessionId: 's-scratch', name: 'orca-scratch-68', cwd: '/tmp/scratch' },
];

test('登録簿とはタイトルで結ぶ。タイトルが名前に /<マシン> を足したものでも当たる', () => {
  assert.equal(sessionForTitle(sessions, '◐ knowledge-10/mac', '/p/knowledge')?.sessionId, 's-k10');
  assert.equal(sessionForTitle(sessions, 'orca-scratch-68/mac', '/tmp/scratch')?.sessionId, 's-scratch');
  // knowledge-1 の名前の頭が knowledge-10 と同じでも取り違えない。
  assert.equal(sessionForTitle(sessions, 'knowledge-1/mac', '/p/knowledge')?.sessionId, 's-k1');
  assert.equal(sessionForTitle(sessions, 'scratch-test', '/tmp/scratch'), null);
  assert.equal(sessionForTitle(sessions, '', '/tmp/scratch'), null);
  // `/<マシン>` の形は1段だけ。名前の後ろに `/` で何段も続くタイトルには当てない。
  assert.equal(sessionForTitle(sessions, 'orca-scratch-68/mac/x', '/tmp/scratch'), null);
});

test('名前そのものに当たるものを、名前に /<マシン> を足した形より先にする', () => {
  const both = [
    { pid: 1, sessionId: 'short', name: 'a', cwd: '/w' },
    { pid: 2, sessionId: 'long', name: 'a/b', cwd: '/w' },
  ];
  assert.equal(sessionForTitle(both, 'a/b', '/w')?.sessionId, 'long');
  assert.equal(sessionForTitle(both, 'a/mac', '/w')?.sessionId, 'short');
});

test('同じ名前が2つあれば作業フォルダーで絞り、それでも決まらなければ引かない', () => {
  const twins = [
    { pid: 1, sessionId: 'a', name: 'x-1', cwd: '/a' },
    { pid: 2, sessionId: 'b', name: 'x-1', cwd: '/b' },
  ];
  assert.equal(sessionForTitle(twins, 'x-1', '/b')?.sessionId, 'b');
  assert.equal(sessionForTitle(twins, 'x-1', '/c'), null);
});

test('agent list の state は paneKey（<tabId>:<leafId>）で端末と結ぶ', () => {
  const agents = [{ paneKey: 't1:l1', state: 'blocked' }];
  assert.equal(agentStateOf(agents, { tabId: 't1', leafId: 'l1' }), 'blocked');
  assert.equal(agentStateOf(agents, { tabId: 't1', leafId: 'l2' }), '');
  assert.equal(agentStateOf(null, { tabId: 't1', leafId: 'l1' }), '');
});

test('見張りの一覧は、生きた claude が登録簿に当たる端末だけ', () => {
  const terminals = [
    { handle: 'term_k', title: '◐ knowledge-10/mac', worktreePath: '/p/knowledge', agentIdentity: 'claude', connected: true, tabId: 't1', leafId: 'l1' },
    // claude が終わった後も agentIdentity は残るが、タイトルが登録簿に当たらない。
    { handle: 'term_s', title: 'scratch-test', worktreePath: '/tmp/scratch', agentIdentity: 'claude', connected: true },
    { handle: 'term_c', title: 'knowledge-1/mac', worktreePath: '/p/knowledge', agentIdentity: 'claude', connected: false },
    { handle: 'term_x', title: 'orca-scratch-68/mac', worktreePath: '/tmp/scratch' },
  ];
  const found = claudeTerminalsFrom(terminals, [{ paneKey: 't1:l1', state: 'working' }], sessions);
  assert.deepEqual(found, [{ id: 'term_k', name: 'knowledge-10/mac', label: 'knowledge-10/mac', sid: 's-k10', cwd: '/p/knowledge', pid: 1, status: 'working' }]);
});

test('送った文でターンが始まったかは stages の turn_started で見る', () => {
  assert.equal(sendStarted({ send: { prompt: { stages: ['input_accepted', 'turn_started'] } } }), true);
  assert.equal(sendStarted({ send: { prompt: { stages: ['input_accepted'] } } }), false);
  assert.equal(sendStarted({}), false);
});

test('送った文が入力欄より上の会話に出ていれば、受け取られている。入力欄の中にあるだけなら数えない', () => {
  const request = '@/tmp/handoff-with-guide.md 前セッションの引き継ぎ資料です。資料の先頭の「再起動した先の進め方」に従って引き継ぐこと。';
  const shown = screen('', ['❯ @/tmp/handoff-with-guide.md', '  前セッションの引き継ぎ資料です。資料の先頭の「再起動した先の進め方」に従って引き継ぐこと。', '⏺ 読んだ']).join('\n');
  assert.equal(submittedOnScreen(shown, request), true);
  assert.equal(submittedOnScreen(screen(request).join('\n'), request), false);
  assert.equal(submittedOnScreen(null, request), false);
});

test('登録簿の pid が claude のプロセスかを、ps のコマンドの名前（comm）か頭の語で見る', () => {
  const comm = ['39992 claude', '  123 /Users/me/.local/share/claude/versions/2.1.330', '  999 vim'].join('\n');
  const args = ['39992 claude --plugin-dir /x --resume abc', '  501 /Users/me/.local/bin/claude', '  777 node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', '  888 node /opt/homebrew/bin/claude', '  999 /usr/bin/vim notes-claude.md'].join('\n');
  assert.deepEqual([...claudePidsFromPs(comm, args)].sort((x, y) => x - y), [501, 888, 39992]);
  assert.deepEqual([...claudePidsFromPs('42 /opt/bin/claude\n', '')], [42]);
});

test('道具は HERDR_ENV=1 を先に、次に ORCA_TERMINAL_HANDLE で見分ける', () => {
  const mux = fileURLToPath(new URL('./mux.mjs', import.meta.url));
  const which = (env) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', `import { backend } from ${JSON.stringify(mux)}; console.log(String(backend()));`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    }).stdout.trim();
  assert.equal(which({ HERDR_ENV: '1', ORCA_TERMINAL_HANDLE: 'term_1' }), 'herdr');
  assert.equal(which({ ORCA_TERMINAL_HANDLE: 'term_1' }), 'orca');
  assert.equal(which({}), 'null');
});

test('フォルダーは実体のパスで比べ、解決できなければ違うとみなす', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  assert.equal(sameDir(dir, `${dir}/.`), true);
  assert.equal(sameDir(dir, fileURLToPath(new URL('..', import.meta.url))), false);
  assert.equal(sameDir('', dir), false);
  assert.equal(sameDir('/no/such/dir', '/no/such/dir'), false);
});

test('タイトルに当たる登録を全部返す。当たらなければ空、2つあれば2つ（閉じてよいかの見分けで、空だけを「claude がいない」とする）', () => {
  const twins = [
    { pid: 1, sessionId: 'a', name: 'x-1', cwd: '/a' },
    { pid: 2, sessionId: 'b', name: 'x-1', cwd: '/b' },
  ];
  assert.equal(sessionsForTitle(twins, 'x-1/mac').length, 2);
  assert.deepEqual(sessionsForTitle(twins, 'clipkeep'), []);
  assert.deepEqual(sessionsForTitle(twins, null), []);
});
