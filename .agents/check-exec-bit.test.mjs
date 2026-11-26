import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./check-exec-bit.mjs', import.meta.url));

test('shebang があって 100644 のファイルだけを挙げて落ち、権限を付けると通る', (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), 'exec-bit-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo });
  const check = (cwd = repo) => spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });

  git('init', '-q');
  mkdirSync(path.join(repo, 'sub dir'));
  writeFileSync(path.join(repo, 'sub dir', '道具.mjs'), '#!/usr/bin/env node\n');
  writeFileSync(path.join(repo, 'lib.mjs'), '// 2行目の shebang は数えない\n#!/bin/sh\n');
  git('add', '.');
  git('update-index', '--chmod=-x', 'sub dir/道具.mjs');

  const failed = check(path.join(repo, 'sub dir'));
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /chmod=\+x 'sub dir\/道具\.mjs'/);
  assert.doesNotMatch(failed.stderr, /lib\.mjs/);

  git('update-index', '--chmod=+x', 'sub dir/道具.mjs');
  assert.equal(check().status, 0);
});
