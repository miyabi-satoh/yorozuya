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

// 自分の端末。hc の端末なら HC_TERMINAL_ID、Herdr の中なら HERDR_ENV=1 と HERDR_PANE_ID、Orca の端末なら ORCA_TERMINAL_HANDLE がある。
// hc を先に見る（hc の端末は core を起動した環境の HERDR_ENV を引き継ぐ）。Herdr と Orca の両方あれば Herdr を先にする
// （scripts/lib/mux.mjs と同じ見分け方）。どれでもなければ見張らない。
type Terminal = { kind: 'hc'; id: string } | { kind: 'herdr'; pane: string } | { kind: 'orca'; handle: string; worktree: string | undefined }

async function ownTerminal($: EngineInterface): Promise<Terminal | undefined> {
  const id = await $.env.get('HC_TERMINAL_ID')
  if (id) return { kind: 'hc', id }
  const pane = await $.env.get('HERDR_PANE_ID')
  if ((await $.env.get('HERDR_ENV')) === '1') return pane === undefined ? undefined : { kind: 'herdr', pane }
  const handle = await $.env.get('ORCA_TERMINAL_HANDLE')
  return handle ? { kind: 'orca', handle, worktree: await $.env.get('ORCA_WORKTREE_ID') } : undefined
}

// orca terminal read --screen --json の結果から画面の文字を取る。描けなかったとき（source が screen でない）は読めない扱い。
// 読み方は scripts/lib/orca.mjs の screenFromRead と同じ（変えるときは両方を直す）。mod は外の CLI を $.process で呼ぶ決まりで、scripts のモジュールを読み込まないので写している。
export function orcaScreenOf(stdout: string): string | null {
  try {
    const terminal = JSON.parse(stdout)?.result?.terminal
    if (!Array.isArray(terminal?.tail) || (terminal.source !== undefined && terminal.source !== 'screen')) return null
    return terminal.tail.join('\n') as string
  } catch {
    return null
  }
}

// hc は CLAUDE*・HERDR_* を外した環境で呼ぶ。core が動いていなければ hc がその場で core を起動し、core はその環境を以後のどの端末にも
// 引き継ぐため（claude の中から起動すると、そこで起動した claude が会話の記録を書かない）。$.process.run の env は上書きしかできず
// 変数を外せないので、node を挟んで外してから hc を起動する（scripts/lib/hc.mjs の hcEnv と同じ外し方）。
export const HC_LAUNCHER =
  "const{spawnSync}=require('node:child_process');" +
  "const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(CLAUDE|HERDR_)/.test(k)));" +
  "const r=spawnSync('hc',process.argv.slice(1),{env,stdio:'inherit'});process.exit(r.status??1)"
export const hcArgv = (...args: string[]) => ['node', '-e', HC_LAUNCHER, ...args]

// hc の read --json の結果から画面の文字を取る。読めなければ null（scripts/lib/hc.mjs の readScreen と同じ読み方）。
export function hcScreenOf(stdout: string): string | null {
  try {
    const text = JSON.parse(stdout)?.text
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

// Orca と hc で読めなければ null（Orca を開き直した後の古いハンドルなど、読めないまま続くことがある）。
// 呼び出し側は読めないときに知らせを見送る。Herdr は読めなければ '' のまま（分ける前と同じ）。
async function readScreen($: EngineInterface, own: Terminal): Promise<string | null> {
  // 空白がノーブレークスペースで来ることがある（scripts/lib/herdr.mjs の readScreen と同じに揃える）。
  if (own.kind === 'hc') {
    const { exitCode, stdout } = await $.process.run(hcArgv('read', '--json', own.id))
    const screen = exitCode === 0 ? hcScreenOf(stdout) : null
    return screen === null ? null : screen.replace(NBSP, ' ')
  }
  if (own.kind === 'orca') {
    const { exitCode, stdout } = await $.process.run(['orca', 'terminal', 'read', '--terminal', own.handle, '--screen', '--json'])
    const screen = exitCode === 0 ? orcaScreenOf(stdout) : null
    return screen === null ? null : screen.replace(NBSP, ' ')
  }
  const { exitCode, stdout } = await $.process.run(['herdr', 'pane', 'read', own.pane, '--source', 'visible'])
  return exitCode === 0 ? stdout.replace(NBSP, ' ') : ''
}

// hc の get --json の結果から claude の作業フォルダーを取る（前景のプロセスの cwd、無ければ端末を作ったときの cwd。scripts/lib/hc.mjs の cwdOf と同じ）。
export function hcCwdOf(stdout: string): string | undefined {
  try {
    const info = JSON.parse(stdout)
    return [info?.foreground?.cwd, info?.cwd].find(value => typeof value === 'string' && value !== '')
  } catch {
    return undefined
  }
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
// 画面を読めなければ、/goal が動いているかもしれないので、動いているとみなして見送る。
const isGoalActive = async ($: EngineInterface, own: Terminal) => {
  const screen = await readScreen($, own)
  return screen === null || screen.includes(GOAL_PATTERN)
}

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
  const own = await ownTerminal($)
  if (own === undefined) return
  const dir = await skillDir($)
  const guide = `${dir}/restart-self.md に従って、このセッション自身を再起動する。`
  const current = await read($, told)

  if (!current.over) {
    const config = await $.fs.read(`${dir}/config.local.json`).catch(() => undefined)
    const threshold = thresholdOf(typeof config === 'string' ? config : undefined)
    const { percent } = (await $.session.usage()).context
    if (percent !== undefined && percent >= threshold && !(await isGoalActive($, own))) {
      await update($, told, t => ({ ...t, over: true }))
      await $.prompt.submit({ text: `[コンテキストの見張り] OVER ${percent}%（閾値 ${threshold}%）。${guide}` })
      return
    }
  }

  const { exitCode, stdout } = await $.process.run(['claude', '--version'])
  const installed = exitCode === 0 ? versionOf(stdout) : undefined
  const { version: running } = await $.session.version()
  if (installed !== undefined && installed !== running && current.update !== installed && !(await isGoalActive($, own))) {
    await update($, told, t => ({ ...t, update: installed }))
    await $.prompt.submit({ text: `[コンテキストの見張り] UPDATE ${running} → ${installed}。Claude Code の更新を反映するため、${guide}` })
    return
  }

  // 自動更新に失敗していれば、起動し直して更新をやり直させる。起動し直しても同じ版で失敗し続けるなら、
  // 再起動を繰り返さないよう、Herdr の名前と版の組みごとに1回だけにする（再起動でペインは変わり、名前は引き継がれる。
  // セッションをまたぐので $.store に持つ）。名前が取れなければ、再起動の後も同じ鍵になる版だけで見る。
  // 新しい版が入っていれば、再起動は UPDATE の側に任せる（知らせ済みで再起動を待っている間と、/goal で見送った間）。
  if (installed !== undefined && installed !== running) return
  const screen = await readScreen($, own)
  if (screen === null) return
  const row = noticeRowOf(screen)
  if (!row.includes(UPDATE_FAILED_PATTERN) || screen.includes(GOAL_PATTERN)) return
  const keyName = await failedKeyName($, own)
  // Orca・hc で作業フォルダーが分からなければ、ほかのセッションと鍵を分けられないので知らせない。
  if (own.kind !== 'herdr' && keyName === undefined) return
  const failedKey = `updateFailed:${keyName ?? '-'}`
  if ((await $.store.get(failedKey)) !== running) {
    // OVER・UPDATE と同じく、送る前に覚えて消さない。submit が知らせのターンを終えてから返るなら、
    // 後で覚えると再起動で落ちて覚えられず、繰り返しを止められないため。送れなかったときの再試行はしない。
    await $.store.set(failedKey, running)
    await $.prompt.submit({ text: `[コンテキストの見張り] UPDATE FAILED ${running}（${row.trim()}）。Claude Code の自動更新をやり直すため、${guide}` })
  }
}

// 自動更新の失敗を1回だけにする鍵の名前。Herdr は名前を再起動の後へ引き継ぐ。
// Orca では claude の名前も端末のハンドルもセッションIDも再起動のたびに変わる（自己再起動は端末を分割して移る）ので、
// 再起動の前後で変わらない作業フォルダー（ORCA_WORKTREE_ID）で代える。変わるものを鍵に入れると、再起動のたびに別の鍵になり、
// 同じ版で失敗し続ける間、再起動を繰り返す。同じ作業フォルダーの2つ目のセッションには知らせないが、1つ目の再起動で更新がやり直される。
// hc も、立て直すと端末の address と名前（`<名前>` と `<名前>-2` を行き来する）が変わるので、claude の作業フォルダーで代える。
async function failedKeyName($: EngineInterface, own: Terminal) {
  if (own.kind === 'orca') return own.worktree ? `orca:${own.worktree}` : undefined
  if (own.kind === 'hc') {
    const got = await $.process.run(hcArgv('get', '--json', own.id))
    const cwd = got.exitCode === 0 ? hcCwdOf(got.stdout) : undefined
    return cwd ? `hc:${cwd}` : undefined
  }
  const list = await $.process.run(['herdr', 'agent', 'list'])
  return list.exitCode === 0 ? agentNameOf(list.stdout, own.pane) : undefined
}

// 放置されて大きくなったら、モデルのターンを使わずに自分のペインで /clear して続ける（idle-clear-self.mjs）。
async function checkIdle($: EngineInterface) {
  const own = await ownTerminal($)
  if (own === undefined) return
  const now = await $.clock.now()
  if (now - lastAnswerAt < IDLE_AFTER_MS || now - idleSkippedAt < IDLE_RETRY_AFTER_MS) return
  if ((await read($, told)).idle) return
  const { tokens } = (await $.session.usage()).context
  if (tokens === undefined || tokens < IDLE_MIN_TOKENS || (await isGoalActive($, own))) return
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
