#!/usr/bin/env node
// Codex CLI の app-server(JSON-RPC over stdio)に account/rateLimits/read を投げ、primary(5時間枠)・secondary(週次枠)の使用率とリセット時刻をJSONで出す。
// クォータは消費しない(既存ツール cclimits・codex-cli-usage も同じ前提で使っている)。
//
// usage: codex-usage.mjs
// 出力: { primary: {usedPercent, resetsAt, windowDurationMins}, secondary: {...}, planType, accountId }

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const TIMEOUT_MS = 8000;

function run() {
  return new Promise((resolve, reject) => {
    const proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = createInterface({ input: proc.stdout });
    let settled = false;
    let stderr = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error('codex app-server からの応答がタイムアウトした'));
    }, TIMEOUT_MS);

    function finish(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      proc.kill();
      fn();
    }

    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 2) {
        if (msg.error) {
          finish(() => reject(new Error(`account/rateLimits/read エラー: ${JSON.stringify(msg.error)}`)));
        } else {
          finish(() => resolve(msg.result));
        }
      }
    });

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('error', (err) => {
      finish(() => reject(new Error(`codex を起動できなかった: ${err.message}`)));
    });

    proc.on('exit', (code) => {
      if (!settled) {
        finish(() => reject(new Error(`codex app-server が先に終了した(code ${code}): ${stderr.trim()}`)));
      }
    });

    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'weekly-pace', version: '0.0.1' } } }) + '\n');
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} }) + '\n');
  });
}

try {
  const result = await run();
  const rl = result.rateLimits ?? {};
  const out = {
    accountId: result.accountId ?? null,
    planType: rl.planType ?? null,
    primary: rl.primary ?? null,
    secondary: rl.secondary ?? null,
  };
  console.log(JSON.stringify(out));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
