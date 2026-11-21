// node --test lib/hc.test.mjs
// hc（herdr-core）の CLI の出力の読み方を、実測した出力の形（hc 0.1.21）で確かめる。CLI を叩く所は、引数を書き残す偽物の hc を PATH の先頭に置いて試す。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  claudeTerminalsFrom,
  cwdOf,
  draftFromHcScreen,
  hcEnv,
  isClaude,
  isLocal,
  parseHcError,
  rawEnv,
  sessionIdOf,
  slugName,
  startedOf,
  statusOf,
  successorName,
} from './hc.mjs';

const border = '─'.repeat(40);
const screen = (input) => ['⏺ ok', `${'─'.repeat(30)} knowledge-10/mac ─`, `❯ ${input}`.trimEnd(), border, '  Model: Opus 5.5 | Ctx Used: 28.0%'].join('\n');

// hc get の形（0.1.21）。claude を端末のプログラムとして起動したもの。
const claudeInfo = (extra = {}) => ({
  address: 't3',
  name: 'knowledge-4b',
  state: 'live',
  cwd: '/Users/me/Projects/knowledge',
  pid: 100,
  foreground: { pid: 100, name: 'claude', argv: ['claude'], cwd: '/Users/me/Projects/knowledge' },
  labels: { claude_transcript: '/Users/me/.claude/projects/-Users-me-Projects-knowledge/0b6c1a2e-1111-2222-3333-444455556666.jsonl' },
  status: { state: 'idle' },
  turn: 0,
  ...extra,
});

test('失敗は stderr の {"error":{"kind"}} から読む', () => {
  assert.deepEqual(parseHcError('{"error":{"kind":"name_taken","message":"a live terminal is already named \\"x\\""}}'), {
    kind: 'name_taken',
    message: 'a live terminal is already named "x"',
  });
  assert.equal(parseHcError('not json'), null);
});

test('セッションIDはラベル claude_transcript の記録のファイル名から取る。Windows のパスも分ける', () => {
  assert.equal(sessionIdOf(claudeInfo()), '0b6c1a2e-1111-2222-3333-444455556666');
  assert.equal(sessionIdOf({ labels: { claude_transcript: 'C:\\Users\\me\\.claude\\projects\\x\\abc-1.jsonl' } }), 'abc-1');
  assert.equal(sessionIdOf({ labels: {} }), '');
  assert.equal(sessionIdOf({ labels: { claude_transcript: '/x/abc.txt' } }), '');
  assert.equal(sessionIdOf(null), '');
});

test('status は claude が知らせる語。知らせていなければ空', () => {
  assert.equal(statusOf(claudeInfo({ status: { state: 'working' } })), 'working');
  assert.equal(statusOf(claudeInfo({ status: null })), '');
  assert.equal(statusOf(null), '');
});

test('claude かは前景のプロセスで見る。終わってシェルに戻った端末・終わった端末は claude でない', () => {
  assert.equal(isClaude(claudeInfo()), true);
  assert.equal(isClaude(claudeInfo({ foreground: { pid: 9, name: 'node', argv: ['node', '/opt/lib/node_modules/.bin/claude'], cwd: '/w' } })), true);
  assert.equal(isClaude(claudeInfo({ foreground: { pid: 9, name: 'bash', argv: ['bash', '-l'], cwd: '/w' } })), false);
  assert.equal(isClaude(claudeInfo({ state: 'finished', foreground: null })), false);
  assert.equal(isClaude(claudeInfo({ foreground: { pid: 9, name: 'claude-helper', argv: ['claude-helper'], cwd: '/w' } })), false);
});

test('cwd は前景のプロセスのものを先にし、無ければ端末を作ったときのもの', () => {
  assert.equal(cwdOf(claudeInfo({ cwd: '/a', foreground: { cwd: '/b' } })), '/b');
  assert.equal(cwdOf(claudeInfo({ cwd: '/a', foreground: null })), '/a');
  assert.equal(cwdOf(null), '');
});

test('入力欄は色の無い画面から読む。案内（Try "…"）だけは空とみなし、ほかは書きかけ', () => {
  assert.equal(draftFromHcScreen(screen('')), '');
  assert.equal(draftFromHcScreen(screen('Try "fix lint errors"')), '');
  assert.equal(draftFromHcScreen(screen('書きかけ')), '書きかけ');
  assert.equal(draftFromHcScreen('枠の無い画面'), null);
  assert.equal(draftFromHcScreen(null), null);
});

test('見張りの一覧は claude の端末だけ。名前が無ければ address を見出しにする', () => {
  const shell = claudeInfo({ address: 't4', foreground: { pid: 5, name: 'bash', argv: ['bash'], cwd: '/w' } });
  const unnamed = claudeInfo({ address: 't5', name: null, title: '' });
  assert.deepEqual(claudeTerminalsFrom([claudeInfo(), shell, unnamed, null]), [
    { id: 't3', name: 'knowledge-4b', label: 'knowledge-4b', sid: '0b6c1a2e-1111-2222-3333-444455556666', cwd: '/Users/me/Projects/knowledge', status: 'idle' },
    { id: 't5', name: '', label: 't5', sid: '0b6c1a2e-1111-2222-3333-444455556666', cwd: '/Users/me/Projects/knowledge', status: 'idle' },
  ]);
});

test('ほかのマシンの端末（machine/t7）は、このマシンの端末に数えない', () => {
  assert.equal(isLocal('t7'), true);
  assert.equal(isLocal('aero/t5'), false);
  assert.equal(isLocal(''), false);
});

test('名前は hc の規則（a-z 0-9 - _ を 32 字まで）に合わせ、読める形に残す', () => {
  assert.equal(slugName('knowledge-4b: dev-server'), 'knowledge-4b-dev-server');
  assert.equal(slugName('Clipkeep-2C: テスト'), 'clipkeep-2c');
  assert.equal(slugName('テスト'), '');
  assert.equal(slugName('a'.repeat(31) + '-bcd'), 'a'.repeat(31));
});

test('立て直す先の名前は、空いていればそのまま、旧が握っていれば -2 と行き来する', () => {
  assert.equal(successorName('knowledge-4b', new Set()), 'knowledge-4b');
  assert.equal(successorName('knowledge-4b', new Set(['knowledge-4b'])), 'knowledge-4b-2');
  assert.equal(successorName('knowledge-4b-2', new Set(['knowledge-4b-2'])), 'knowledge-4b');
  assert.equal(successorName('', new Set()), '');
  assert.equal(successorName('a'.repeat(32), new Set(['a'.repeat(32)])).length, 32);
  // 行き来する先もほかの端末が握っていれば、空いた番号にする。もとの名前の後ろの数（-4b など）は外さない。
  assert.equal(successorName('knowledge-4b-2', new Set(['knowledge-4b-2', 'knowledge-4b'])), 'knowledge-4b-3');
  assert.equal(successorName('knowledge-4b', new Set(['knowledge-4b', 'knowledge-4b-2'])), 'knowledge-4b-3');
  const all = new Set(['x', ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `x-${n}`)]);
  assert.equal(successorName('x', all), '');
});

test('動き出したかは、working・done・ターンが進んだかで見る。終わった端末・ダイアログはそれぞれ分ける', () => {
  assert.equal(startedOf(claudeInfo({ status: { state: 'working' } })), 'started');
  // 起動したばかりの done は、依頼を受け取ったしるしにしない。
  assert.equal(startedOf(claudeInfo({ status: { state: 'done' }, turn: 0 })), null);
  assert.equal(startedOf(claudeInfo({ status: { state: 'idle' }, turn: 1 })), 'started');
  assert.equal(startedOf(claudeInfo({ status: { state: 'blocked' } })), 'blocked');
  assert.equal(startedOf(claudeInfo({ state: 'finished' })), 'exited');
  assert.equal(startedOf(claudeInfo({ status: { state: 'idle' } })), null);
  assert.equal(startedOf(null), null);
});

test('hc に渡す環境から CLAUDE*・HERDR_* を外す（core を起動すると全部の端末に引き継がれるため）。送るときは HC_TERMINAL_ID も外す', () => {
  const env = { HC_TERMINAL_ID: 't3', HC_SCOPE: 's', PATH: '/bin', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDECODE: '1', HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p2' };
  assert.deepEqual(hcEnv(env), { HC_TERMINAL_ID: 't3', HC_SCOPE: 's', PATH: '/bin' });
  assert.deepEqual(rawEnv(env), { HC_SCOPE: 's', PATH: '/bin' });
});

// 偽物の hc。引数と HC_TERMINAL_ID を1行ずつ書き残し、サブコマンドごとに決まった出力を返す。
function fakeHc(t) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-test-'));
  const calls = path.join(bin, 'calls');
  fs.writeFileSync(
    path.join(bin, 'hc'),
    `#!/bin/sh
printf '%s|%s|%s\\n' "\${HC_TERMINAL_ID-unset}" "\${CLAUDE_CODE_CHILD_SESSION-unset}\${HERDR_ENV-unset}" "$*" >> '${calls}'
case "$1" in
  send) echo '{"started":true,"status":"idle","turn":0}' ;;
  run) echo '{"address":"t9","agent":"claude","cwd":"/w","name":"x","state":"live","turn":0}' ;;
  get) if [ -e '${bin}/killed' ]; then echo '{"address":"t9","state":"finished"}'; else echo '{"address":"t9","state":"live"}'; fi ;;
  kill) touch '${bin}/killed'; echo '{"address":"t9","state":"finished"}' ;;
  rm) echo '{"removed":"t9"}' ;;
  ls) echo '{"terminals":[],"hidden_finished":0,"machines":[]}' ;;
  *) echo '{"error":{"kind":"not_found","message":"no terminal"}}' >&2; exit 3 ;;
esac
`,
    { mode: 0o755 },
  );
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const lib = fileURLToPath(new URL('./hc.mjs', import.meta.url));
  const call = (code) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', `import * as hc from ${JSON.stringify(lib)}; ${code}`], {
      encoding: 'utf8',
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HC_TERMINAL_ID: 't3', CLAUDE_CODE_CHILD_SESSION: '1', HERDR_ENV: '1' },
    });
  const seen = () => fs.readFileSync(calls, 'utf8').trim().split('\n');
  return { call, seen };
}

test('送る文は -- の後に置き、呼び出し元の端末を外して hc send に渡す（包まれると /exit が効かない）', { skip: process.platform === 'win32' }, (t) => {
  const { call, seen } = fakeHc(t);
  const result = call(`console.log(hc.prompt('t5', '/exit'));`);
  assert.equal(result.stdout.trim(), 'true');
  assert.deepEqual(seen(), ['unset|unsetunset|send --json -- t5 /exit']);
});

test('claude は呼び出し元の子にせず、依頼を引数で渡して起動する', { skip: process.platform === 'win32' }, (t) => {
  const { call, seen } = fakeHc(t);
  const result = call(`console.log(hc.startClaude({ cwd: '/w', name: 'knowledge-4b-2', request: '@/tmp/a.md 読むこと' }));`);
  assert.equal(result.stdout.trim(), 't9');
  assert.deepEqual(seen(), ['t3|unsetunset|run --json --bg --no-parent --cwd /w --name knowledge-4b-2 -- claude @/tmp/a.md 読むこと']);
});

test('閉じるときは kill してから、終わったのを見て rm する。失敗は kind で読める', { skip: process.platform === 'win32' }, (t) => {
  const { call, seen } = fakeHc(t);
  assert.equal(call(`console.log(hc.closeTerminal('t9'));`).stdout.trim(), 'true');
  assert.deepEqual(seen(), ['t3|unsetunset|kill --json t9', 't3|unsetunset|get --json t9', 't3|unsetunset|rm --json t9']);
  assert.equal(call(`console.log(hc.hc(['read', 't1']), hc.hcErrorKind());`).stdout.trim(), 'null not_found');
});

test('道具は HC_TERMINAL_ID を一番先に見る（hc の端末は core を起動した環境の HERDR_ENV=1 を引き継ぐ）', () => {
  const mux = fileURLToPath(new URL('./mux.mjs', import.meta.url));
  const which = (env) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', `import { backend, label } from ${JSON.stringify(mux)}; console.log(String(backend()), label());`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    }).stdout.trim();
  assert.equal(which({ HC_TERMINAL_ID: 't3', HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p284', ORCA_TERMINAL_HANDLE: 'term_1' }), 'hc hc');
  assert.equal(which({ HC_TERMINAL_ID: '', HERDR_ENV: '1' }), 'herdr Herdr');
  assert.equal(which({ ORCA_TERMINAL_HANDLE: 'term_1' }), 'orca Orca');
});
