// node --test lib/hc.test.mjs
// hc（herdr-core）の CLI の出力の読み方を、実測した出力の形（hc 0.1.21）で確かめる。CLI を叩く所は、引数を書き残す偽物の hc を PATH の先頭に置いて試す。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  claudeTerminalsFrom,
  cwdOf,
  draftAfterProbe,
  draftFromHcScreen,
  execStdout,
  hcEnv,
  isClaude,
  isLocal,
  machineOf,
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
  labels: {},
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

// claude agents --json の形（2.1.332）。
const SID = '0b6c1a2e-1111-2222-3333-444455556666';
const agents = [
  { pid: 7, cwd: '/w', kind: 'interactive', sessionId: 'other', name: 'rencon-1b', status: 'idle' },
  { pid: 100, cwd: '/Users/me/Projects/knowledge', kind: 'interactive', sessionId: SID, name: 'knowledge-4b', status: 'busy' },
];

test('セッションIDは claude agents から、端末の前景の pid が同じ項目を引く', () => {
  assert.equal(sessionIdOf(claudeInfo(), agents), SID);
  // 前景が無ければ端末のプログラムの pid で引く
  assert.equal(sessionIdOf(claudeInfo({ pid: 7, foreground: null }), agents), 'other');
  // 前景が claude でなければ、端末のプログラムの pid で引き直す
  assert.equal(sessionIdOf(claudeInfo({ foreground: { pid: 8 } }), agents), SID);
  assert.equal(sessionIdOf(claudeInfo({ pid: 8, foreground: { pid: 8 } }), agents), '');
  assert.equal(sessionIdOf(claudeInfo(), null), '');
  assert.equal(sessionIdOf(null, agents), '');
});

test('ほかのマシンの端末は、address の前の部分をマシンとして引く', () => {
  assert.equal(machineOf('mac-mini-2020/t160'), 'mac-mini-2020');
  assert.equal(machineOf('t3'), '');
  assert.equal(machineOf(undefined), '');
});

test('hc exec の stdout は base64。終了コードが 0 でなければ null', () => {
  assert.equal(execStdout({ code: 0, stdout: Buffer.from('[]').toString('base64') }), '[]');
  assert.equal(execStdout({ code: 1, stdout: '', stderr: Buffer.from('boom').toString('base64') }), null);
  assert.equal(execStdout(null), null);
});

test('1字打って、その字だけになれば入力候補、書きかけの末尾に付けば書きかけ', () => {
  assert.equal(draftAfterProbe('#64 まで入れ直して', 'x'), '');
  assert.equal(draftAfterProbe('#64 まで入れ直して', '#64 まで入れ直してx'), '#64 まで入れ直して');
  // 読めなかったら止まる側に倒す
  assert.equal(draftAfterProbe('書きかけ', null), '書きかけ');
  assert.equal(draftAfterProbe('', 'x'), '');
  assert.equal(draftAfterProbe(null, 'x'), null);
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
  assert.deepEqual(claudeTerminalsFrom([claudeInfo(), shell, unnamed, null], agents), [
    { id: 't3', name: 'knowledge-4b', label: 'knowledge-4b', sid: SID, cwd: '/Users/me/Projects/knowledge', status: 'idle' },
    { id: 't5', name: '', label: 't5', sid: SID, cwd: '/Users/me/Projects/knowledge', status: 'idle' },
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
  keys) ;;
  exec) printf '{"code":0,"stdout":"%s"}\n' "$(printf '[{"pid":100,"sessionId":"s1"}]' | base64 | tr -d '\n')" ;;
  label) if [ -z "$4" ]; then echo '{"error":{"kind":"not_found","message":"no terminal"}}' >&2; exit 3; fi ;;
  read) echo 'not json' ;;
  *) echo '{"error":{"kind":"not_found","message":"no terminal"}}' >&2; exit 3 ;;
esac
`,
    { mode: 0o755 },
  );
  // rencon の偽物。--skill は bin/old があれば 2（handover の無い古い版）、無ければ 0。handover は呼ばれた引数を書き残し、run だけ hc の偽物へ流す。
  fs.writeFileSync(
    path.join(bin, 'rencon'),
    `#!/bin/sh
if [ "$1" = --skill ]; then [ -e '${bin}/old' ] && exit 2; exit 0; fi
printf 'rencon %s\\n' "$*" >> '${calls}'
[ "$2" = run ] || exit 0
shift 4
exec '${bin}/hc' run "$@"
`,
    { mode: 0o755 },
  );
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const lib = new URL('./hc.mjs', import.meta.url).href;
  const call = (code) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', `import * as hc from ${JSON.stringify(lib)}; ${code}`], {
      encoding: 'utf8',
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HC_TERMINAL_ID: 't3', CLAUDE_CODE_CHILD_SESSION: '1', HERDR_ENV: '1' },
    });
  const seen = () => fs.readFileSync(calls, 'utf8').trim().split('\n');
  return { call, seen, bin };
}

test('送る文は -- の後に置き、呼び出し元の端末を外して hc send に渡す（包まれると /exit が効かない）', { skip: process.platform === 'win32' }, (t) => {
  const { call, seen } = fakeHc(t);
  const result = call(`console.log(hc.prompt('t5', '/exit'));`);
  assert.equal(result.stdout.trim(), 'true');
  assert.deepEqual(seen(), ['unset|unsetunset|send --json -- t5 /exit']);
});

test('claude は呼び出し元の子にせず、依頼を引数で渡して、rencon handover run で旧の端末の代わりに起動する', { skip: process.platform === 'win32' }, (t) => {
  const { call, seen } = fakeHc(t);
  const result = call(`console.log(hc.startClaude({ cwd: '/w', name: 'knowledge-4b-2', request: '@/tmp/a.md 読むこと', replaces: 't1b' }));`);
  assert.equal(result.stdout.trim(), 't9');
  assert.deepEqual(seen(), [
    'rencon handover run t1b -- --json --bg --no-parent --cwd /w --name knowledge-4b-2 -- claude @/tmp/a.md 読むこと',
    't3|unsetunset|run --json --bg --no-parent --cwd /w --name knowledge-4b-2 -- claude @/tmp/a.md 読むこと',
  ]);
});

test('handover の無い rencon なら、ただの hc run で起動し、タイルの保持は飛ばす', { skip: process.platform === 'win32' }, (t) => {
  const { call, seen, bin } = fakeHc(t);
  fs.writeFileSync(path.join(bin, 'old'), '');
  const result = call(`console.log(hc.startClaude({ cwd: '/w', name: 'k', request: 'r', replaces: 't1b' }), hc.markRestarting('t5'), hc.markRestarting('t5', false));`);
  assert.equal(result.stdout.trim(), 't9 true true');
  assert.deepEqual(seen(), ['t3|unsetunset|run --json --bg --no-parent --cwd /w --name k -- claude r']);
});

test('rencon handover 自身が落ちたら、ただの hc run で起動し直す。hc のエラーなら起動し直さない', { skip: process.platform === 'win32' }, (t) => {
  const { call, seen, bin } = fakeHc(t);
  fs.writeFileSync(path.join(bin, 'rencon'), `#!/bin/sh\nif [ "$1" = --skill ]; then exit 0; fi\necho 'rencon handover: hc: not found' >&2\nexit 1\n`, { mode: 0o755 });
  assert.equal(call(`console.log(hc.startClaude({ cwd: '/w', name: 'k', request: 'r', replaces: 't1b' }));`).stdout.trim(), 't9');
  assert.deepEqual(seen(), ['t3|unsetunset|run --json --bg --no-parent --cwd /w --name k -- claude r']);
  fs.writeFileSync(path.join(bin, 'rencon'), `#!/bin/sh\nif [ "$1" = --skill ]; then exit 0; fi\necho '{"error":{"kind":"name_taken","message":"taken"}}' >&2\nexit 3\n`, { mode: 0o755 });
  assert.equal(call(`console.log(JSON.stringify(hc.startClaude({ cwd: '/w', name: 'k', request: 'r', replaces: 't1b' })), hc.hcErrorKind());`).stdout.trim(), '"" name_taken');
});

test('立て直しの間のタイルは rencon handover hold で残し、release で戻す', { skip: process.platform === 'win32' }, (t) => {
  const { call, seen } = fakeHc(t);
  assert.equal(call(`console.log(hc.markRestarting('t5'), hc.markRestarting('t5', false));`).stdout.trim(), 'true true');
  assert.deepEqual(seen(), ['rencon handover hold t5', 'rencon handover release t5']);
});

test('閉じるときは kill してから、終わったのを見て rm する。失敗は kind で読める', { skip: process.platform === 'win32' }, (t) => {
  const { call, seen } = fakeHc(t);
  assert.equal(call(`console.log(hc.closeTerminal('t9'));`).stdout.trim(), 'true');
  assert.deepEqual(seen(), ['t3|unsetunset|kill --json t9', 't3|unsetunset|get --json t9', 't3|unsetunset|rm --json t9']);
  assert.equal(call(`console.log(hc.hc(['label', 't1']), hc.hcErrorKind());`).stdout.trim(), 'null not_found');
});

test('claude agents は hc exec で引き、ほかのマシンなら --on を付ける', { skip: process.platform === 'win32' }, (t) => {
  const { call, seen } = fakeHc(t);
  assert.equal(call(`console.log(hc.sessionOf({ address: 'mac/t1', foreground: { pid: 100 } }), JSON.stringify(hc.claudeAgents()));`).stdout.trim(), 's1 [{"pid":100,"sessionId":"s1"}]');
  assert.deepEqual(seen(), ['t3|unsetunset|exec --json --on mac claude agents --json', 't3|unsetunset|exec --json claude agents --json']);
});

test('中身の要らない keys は出力が空でも成功、中身の要る read は JSON でなければ失敗', { skip: process.platform === 'win32' }, (t) => {
  const { call } = fakeHc(t);
  assert.equal(call(`console.log(JSON.stringify(hc.hc(['keys', 't9', 'enter'])));`).stdout.trim(), '{}');
  assert.match(call(`console.log(hc.hc(['read', 't9']), hc.hcError());`).stdout.trim(), /^null hc の出力を JSON として読めない: not json$/);
});

test('道具は HC_TERMINAL_ID を一番先に見る（hc の端末は core を起動した環境の HERDR_ENV=1 を引き継ぐ）', () => {
  const mux = new URL('./mux.mjs', import.meta.url).href;
  const which = (env) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', `import { backend, label } from ${JSON.stringify(mux)}; console.log(String(backend()), label());`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    }).stdout.trim();
  assert.equal(which({ HC_TERMINAL_ID: 't3', HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p284' }), 'hc hc');
  assert.equal(which({ HC_TERMINAL_ID: '', HERDR_ENV: '1' }), 'herdr Herdr');
});
