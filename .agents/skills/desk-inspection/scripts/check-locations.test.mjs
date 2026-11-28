import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./check-locations.mjs', import.meta.url));
const repo = fileURLToPath(new URL('../../../..', import.meta.url));
test('ディレクトリがリポジトリにあるのに無いファイルは NG、ほかは確かめられない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-locations-'));
  try {
    const report = path.join(dir, 'report.html');
    fs.writeFileSync(report, '<li><code>README.md:1</code> <code>.agents/skills/does-not-exist.js:1</code> <code>.agents/no-such-dir/file.js:1</code> <code>/outside/README.md:1</code></li>');
    const result = spawnSync(process.execPath, [script, report, repo], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /NG  \.agents\/skills\/does-not-exist\.js:1/);
    assert.match(result.stdout, /確かめられなかった場所/);
    assert.match(result.stdout, /\/outside\/README\.md:1/);
    assert.match(result.stdout, /no-such-dir\/file\.js:1/);
    assert.doesNotMatch(result.stdout, /NG  \.agents\/no-such-dir/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
