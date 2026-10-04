import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { ContextWatchTold } from '../types'

// 各セッションが自分を見張り、ターンの終わりに閾値を超えていれば、自分で再起動するよう自分に知らせる。
// ターンの終わりは区切りなので、ほかのセッションが区切りを尋ねて返信を待つ仲介が要らない。
// 知らせたかはセッションの状態に持つ。読み込み直し（mod の保存・更新）でも、同じ知らせを二度出さない。
const told = atom({ plugin: 'context-watch', key: 'told' } as const, { over: false, update: null, idle: false } as ContextWatchTold)

const DEFAULT_THRESHOLD = 50
const GOAL_PATTERN = '/goal active'
// 放置の目安は Claude Code の「放置から戻ったときのヒント」に合わせる（10万トークン以上で、最後の応答から75分。2.1.278 のコードで確認）。
export const IDLE_AFTER_MS = 75 * 60 * 1000
export const IDLE_MIN_TOKENS = 100_000
const IDLE_CHECK_EVERY_MS = 60 * 1000
const IDLE_RETRY_AFTER_MS = 10 * 60 * 1000

// 最後に応答した時刻と、放置の /clear を見送った時刻。読み込み直すと初めからになり、待ちが延びるだけで済む。
let lastAnswerAt = 0
let idleSkippedAt = 0

async function skillDir($: EngineInterface) {
  const { realPath } = await $.fs.stat($.plugin.root, { resolve: true })
  return `${realPath ?? $.plugin.root}/..`
}

// 閾値は config.local.json の watch.threshold。無い・読めなければ既定値。
export function thresholdOf(text: string | undefined) {
  try {
    const value = Number(JSON.parse(text ?? '{}')?.watch?.threshold)
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_THRESHOLD
  } catch {
    return DEFAULT_THRESHOLD
  }
}

// `claude --version` の出力（`2.1.290 (Claude Code)`）から版を取る。
export const versionOf = (stdout: string) => stdout.trim().split(/\s+/)[0] || undefined

// `/goal` が動いている間は知らせない（区切りの確かめで、目標追従を途中で止めることになるため）。
async function isGoalActive($: EngineInterface, pane: string) {
  const { exitCode, stdout } = await $.process.run(['herdr', 'pane', 'read', pane, '--source', 'visible'])
  return exitCode === 0 && stdout.includes(GOAL_PATTERN)
}

async function check($: EngineInterface) {
  const pane = await $.env.get('HERDR_PANE_ID')
  if ((await $.env.get('HERDR_ENV')) !== '1' || pane === undefined) return
  const dir = await skillDir($)
  const guide = `${dir}/restart-self.md に従って、このセッション自身を再起動する。`
  const current = await read($, told)

  if (!current.over) {
    const config = await $.fs.read(`${dir}/config.local.json`).catch(() => undefined)
    const threshold = thresholdOf(typeof config === 'string' ? config : undefined)
    const { percent } = (await $.session.usage()).context
    if (percent !== undefined && percent >= threshold && !(await isGoalActive($, pane))) {
      await update($, told, t => ({ ...t, over: true }))
      await $.prompt.submit({ text: `[コンテキストの見張り] OVER ${percent}%（閾値 ${threshold}%）。${guide}` })
      return
    }
  }

  const { exitCode, stdout } = await $.process.run(['claude', '--version'])
  const installed = exitCode === 0 ? versionOf(stdout) : undefined
  const { version: running } = await $.session.version()
  if (installed !== undefined && installed !== running && current.update !== installed && !(await isGoalActive($, pane))) {
    await update($, told, t => ({ ...t, update: installed }))
    await $.prompt.submit({ text: `[コンテキストの見張り] UPDATE ${running} → ${installed}。Claude Code の更新を反映するため、${guide}` })
  }
}

// 放置されて大きくなったら、モデルのターンを使わずに自分のペインで /clear して続ける（idle-clear-self.mjs）。
async function checkIdle($: EngineInterface) {
  const pane = await $.env.get('HERDR_PANE_ID')
  if ((await $.env.get('HERDR_ENV')) !== '1' || pane === undefined) return
  const now = await $.clock.now()
  if (now - lastAnswerAt < IDLE_AFTER_MS || now - idleSkippedAt < IDLE_RETRY_AFTER_MS) return
  if ((await read($, told)).idle) return
  const { tokens } = (await $.session.usage()).context
  if (tokens === undefined || tokens < IDLE_MIN_TOKENS || (await isGoalActive($, pane))) return
  const { exitCode } = await $.process.run(['node', `${await skillDir($)}/scripts/idle-clear-self.mjs`])
  if (exitCode === 0) await update($, told, t => ({ ...t, idle: true }))
  else idleSkippedAt = now
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    lastAnswerAt = await $.clock.now()
    $.clock.every(IDLE_CHECK_EVERY_MS, () => {
      void checkIdle($)
    })
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // サブエージェントのターンと、ユーザーが止めたターンでは見ない。
    if (e.agentId === undefined && !e.isAborted) {
      lastAnswerAt = await $.clock.now()
      await check($)
    }
    return result
  })
}
