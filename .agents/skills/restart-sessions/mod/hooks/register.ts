import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { ContextWatchTold } from '../types'

// 各セッションが自分を見張り、ターンの終わりに閾値を超えていれば、自分で再起動するよう自分に知らせる。
// ターンの終わりは区切りなので、ほかのセッションが区切りを尋ねて返信を待つ仲介が要らない。
// 知らせたかはセッションの状態に持つ。読み込み直し（mod の保存・更新）でも、同じ知らせを二度出さない。
const told = atom({ plugin: 'context-watch', key: 'told' } as const, { over: false, update: null, idle: false } as ContextWatchTold)

const DEFAULT_THRESHOLD = 50
const GOAL_PATTERN = '/goal active'
// 自動更新に失敗した知らせ（2.1.325 では「✘ Auto-update failed · Run claude doctor」）。起動し直すと更新がやり直される。
const UPDATE_FAILED_PATTERN = 'Auto-update failed'
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

// 文字のまま書くと、エディタや整形で普通の空白に化けても見分けられないので、コードで作る。
const NBSP = new RegExp(String.fromCharCode(0xa0), 'g')

async function readScreen($: EngineInterface, pane: string) {
  const { exitCode, stdout } = await $.process.run(['herdr', 'pane', 'read', pane, '--source', 'visible'])
  // 空白がノーブレークスペースで来ることがある（scripts/lib/herdr.mjs の readScreen と同じに揃える）。
  return exitCode === 0 ? stdout.replace(NBSP, ' ') : ''
}

// 自分の Herdr の名前。restart-self.mjs は新しいペインに割って起動し直し、名前だけを引き継ぐ。
export function agentNameOf(listJson: string, pane: string): string | undefined {
  try {
    const agents = JSON.parse(listJson)?.result?.agents
    return Array.isArray(agents) ? agents.find(a => a?.pane_id === pane)?.name || undefined : undefined
  } catch {
    return undefined
  }
}

// `/goal` が動いている間は知らせない（区切りの確かめで、目標追従を途中で止めることになるため）。
const isGoalActive = async ($: EngineInterface, pane: string) => (await readScreen($, pane)).includes(GOAL_PATTERN)

// 更新の知らせは、入力欄の上枠のすぐ上の1行に出る。画面全体に当てると、会話に出てきた同じ文言を拾う。
// 下から見て最初の「─ だけの行」を下枠、その上で最初の「─ で始まる行」を上枠とみなす（scripts/watch-context.mjs と同じ読み方）。
export function noticeRowOf(screen: string) {
  const lines = screen.split('\n')
  let bottom = lines.length - 1
  while (bottom >= 0 && !/^─+\s*$/.test(lines[bottom])) bottom -= 1
  for (let top = bottom - 1; top >= 1; top -= 1) {
    if (lines[top].startsWith('─')) return lines[top - 1]
  }
  return ''
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
    return
  }

  // 自動更新に失敗していれば、起動し直して更新をやり直させる。起動し直しても同じ版で失敗し続けるなら、
  // 再起動を繰り返さないよう、Herdr の名前と版の組みごとに1回だけにする（再起動でペインは変わり、名前は引き継がれる。
  // セッションをまたぐので $.store に持つ）。名前が取れなければ、再起動の後も同じ鍵になる版だけで見る。
  // 新しい版が入っていれば、再起動は UPDATE の側に任せる（知らせ済みで再起動を待っている間と、/goal で見送った間）。
  if (installed !== undefined && installed !== running) return
  const screen = await readScreen($, pane)
  const row = noticeRowOf(screen)
  if (!row.includes(UPDATE_FAILED_PATTERN) || screen.includes(GOAL_PATTERN)) return
  const list = await $.process.run(['herdr', 'agent', 'list'])
  const name = list.exitCode === 0 ? agentNameOf(list.stdout, pane) : undefined
  const failedKey = `updateFailed:${name ?? '-'}`
  if ((await $.store.get(failedKey)) !== running) {
    // 送る前に覚える。submit が知らせのターンを終えてから返るなら、その前に再起動で落ちて覚えられないため。
    // 送れなかったときだけ消し、次のターンの終わりにまた試す。
    await $.store.set(failedKey, running)
    try {
      await $.prompt.submit({ text: `[コンテキストの見張り] UPDATE FAILED ${running}（${row.trim()}）。Claude Code の自動更新をやり直すため、${guide}` })
    } catch (error) {
      await $.store.delete(failedKey)
      throw error
    }
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
