#!/usr/bin/env node
// Claude の使用量 API（Claude Code がログインに使う OAuth トークンで読める）から、5時間枠・週次枠の使用率とリセット時刻を JSON で出す。
// 画面を読まないので、Herdr やステータスラインの表示に依らず、どの OS でも動く。クォータは消費しない。
//
// usage: claude-usage.mjs [--force]
//   --force ならキャッシュを使わずに取り直す。
// 出力: { primary: {usedPercent, resetsAt, windowDurationMins}, secondary: {...}, fetchedAt, stale }
//   codex-usage.mjs と同じ形（primary=5時間枠、secondary=週次枠、resetsAt は UNIX 秒）。
//   stale は、取り直しに失敗して古いキャッシュを返したとき true。

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
// この API はすぐに 429 を返す。週次の判定には15分前の値で足りるので、その間は取り直さない。
const CACHE_FRESH_MS = 15 * 60 * 1000;
// 取り直しに失敗したときに古い値を返してよい上限。週次の着地見込みは1時間ずれても判断が変わらない。
const CACHE_FALLBACK_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 8000;
// macOS の Claude Code は、資格情報をファイルでなくキーチェーンのこの名前の項目に置く。
const MACOS_KEYCHAIN_SERVICE = 'Claude Code-credentials';

const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const cacheDir = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'weekly-pace');
const cachePath = join(cacheDir, 'claude-usage.json');

function readCredentials() {
  try {
    return JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf8'));
  } catch {
    // ファイルが無ければ下のキーチェーンへ
  }
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('security', ['find-generic-password', '-s', MACOS_KEYCHAIN_SERVICE, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return JSON.parse(raw);
    } catch {
      // 下で「資格情報が無い」として扱う
    }
  }
  return null;
}

function accessToken() {
  const oauth = readCredentials()?.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error('Claude Code の資格情報が見つからない。`claude auth login` でログインする。');
  }
  // アクセストークンを更新するのは Claude Code 本体だけ。こちらでは更新しない。
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()) {
    throw new Error('Claude Code のアクセストークンが切れている。Claude Code を起動すれば更新される。');
  }
  return oauth.accessToken;
}

function toWindow(raw, windowDurationMins) {
  if (!raw || typeof raw.utilization !== 'number' || !raw.resets_at) return null;
  return {
    usedPercent: raw.utilization,
    resetsAt: Math.round(Date.parse(raw.resets_at) / 1000),
    windowDurationMins,
  };
}

async function fetchUsage() {
  const res = await fetch(USAGE_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`使用量 API が HTTP ${res.status} を返した`);
  const body = await res.json();
  return {
    primary: toWindow(body.five_hour, 5 * 60),
    secondary: toWindow(body.seven_day, 7 * 24 * 60),
    fetchedAt: Date.now(),
  };
}

function readCache() {
  try {
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch {
    return null;
  }
}

const cached = readCache();
const age = cached ? Date.now() - cached.fetchedAt : Infinity;

if (!process.argv.includes('--force') && age < CACHE_FRESH_MS) {
  console.log(JSON.stringify({ ...cached, stale: false }));
  process.exit(0);
}

try {
  const usage = await fetchUsage();
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(usage));
  console.log(JSON.stringify({ ...usage, stale: false }));
} catch (err) {
  if (age < CACHE_FALLBACK_MS) {
    process.stderr.write(`${err.message}。${Math.round(age / 60000)}分前の値を返す。\n`);
    console.log(JSON.stringify({ ...cached, stale: true }));
    process.exit(0);
  }
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
