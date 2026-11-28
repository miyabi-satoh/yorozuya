import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shellFor } from './shell-choice.mjs';

const existsIn = (...files) => file => files.includes(file);
test('Windows は指定された Git Bash を優先する', () => {
  const bash = 'C:\\Tools\\Git Bash\\bash.exe';
  assert.deepEqual(shellFor('exit 3', 'win32', { CLAUDE_CODE_GIT_BASH_PATH: bash }, existsIn(bash)), [bash, ['-c', 'exit 3']]);
});
test('PATH の git.exe から Git Bash を探し、WSL の bash は使わない', () => {
  const git = 'C:\\Git\\cmd\\git.exe', bash = 'C:\\Git\\bin\\bash.exe';
  assert.deepEqual(shellFor('echo ok', 'win32', { PATH: 'C:\\Windows\\System32;C:\\Git\\cmd' }, existsIn(git, bash, 'C:\\Windows\\System32\\bash.exe')), [bash, ['-c', 'echo ok']]);
  assert.equal(shellFor('echo ok', 'win32', { PATH: 'C:\\Windows\\System32' }, existsIn('C:\\Windows\\System32\\bash.exe'))[0], 'pwsh');
});
test('標準の Git Bash と他の OS のシェルを選ぶ', () => {
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  assert.equal(shellFor('x', 'win32', { ProgramFiles: 'C:\\Program Files' }, existsIn(bash))[0], bash);
  assert.deepEqual(shellFor('x', 'darwin', { SHELL: '/bin/zsh' }, existsIn()), ['/bin/zsh', ['-c', 'x']]);
});
