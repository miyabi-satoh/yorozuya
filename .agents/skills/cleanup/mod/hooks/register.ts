import type { EngineInterface, Register } from 'claude-code'

// 各セッションがディスクの空きを測り、ラインを切ったら、自分のリポジトリを片付けるよう自分に知らせる。
// 片付けるのは持ち主のセッション自身なので、使用中かどうかを外から推し量らずに済む。
// 知らせたリポジトリは、セッションをまたぐ $.store に持つ。同じリポジトリを開く複数のセッションのうち1つだけに知らせ、
// 空きが戻るまで（戻らなければ1日おきに）知らせ直さない。

const GB = 1024 ** 3
const DEFAULT_MIN_FREE_GB = 20
const DEFAULT_RECOVER_GB = 30
const FIRST_CHECK_AFTER_MS = 60 * 1000
const CHECK_EVERY_MS = 10 * 60 * 1000
export const RENOTIFY_AFTER_MS = 24 * 60 * 60 * 1000
const NOTIFIED_KEY = 'notified'

export type DiskWatchConfig = { minFreeGB: number; recoverGB: number; sharedCachesRepo: string | undefined }

// 設定は config.local.json の diskWatch。無い・読めない値は既定値。recoverGB は minFreeGB より小さくしない。
export function configOf(text: string | undefined): DiskWatchConfig {
  let raw: { minFreeGB?: unknown; recoverGB?: unknown; sharedCachesRepo?: unknown } = {}
  try {
    raw = JSON.parse(text ?? '{}')?.diskWatch ?? {}
  } catch {}
  const positive = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)
  const minFreeGB = positive(raw.minFreeGB, DEFAULT_MIN_FREE_GB)
  const recoverGB = Math.max(positive(raw.recoverGB, DEFAULT_RECOVER_GB), minFreeGB)
  const sharedCachesRepo = typeof raw.sharedCachesRepo === 'string' && raw.sharedCachesRepo !== '' ? raw.sharedCachesRepo : undefined
  return { minFreeGB, recoverGB, sharedCachesRepo }
}

// `df -kP` の2行目の4列目（空きの KiB）。
export function freeBytesOfDf(stdout: string) {
  const fields = stdout.trim().split('\n')[1]?.trim().split(/\s+/)
  const kib = Number(fields?.[3])
  return Number.isFinite(kib) ? kib * 1024 : null
}

async function skillDir($: EngineInterface) {
  const { realPath } = await $.fs.stat($.plugin.root, { resolve: true })
  return (realPath ?? $.plugin.root).replace(/[\\/]mod[\\/]?$/, '')
}

// ホームのあるボリュームの空き。macOS / Linux は df、Windows は PowerShell。測れなければ null。
async function measureFree($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? (await $.session.cwd())
  const df = await $.process.run(['df', '-kP', home]).catch(() => undefined)
  if (df?.exitCode === 0) return freeBytesOfDf(df.stdout)
  const ps = await $.process
    .run(['powershell', '-NoProfile', '-Command', '(Get-Item $env:USERPROFILE).PSDrive.Free'])
    .catch(() => undefined)
  const free = Number(ps?.stdout.trim())
  return ps?.exitCode === 0 && Number.isFinite(free) ? free : null
}

// リポジトリの元の clone のパス。worktree からも同じになるので、同じリポジトリのセッションを1つにまとめられる。
async function repoRoot($: EngineInterface) {
  const { exitCode, stdout } = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (exitCode !== 0) return null
  return stdout.trim().replace(/[\\/]\.git[\\/]?$/, '') || null
}

export async function check($: EngineInterface) {
  const free = await measureFree($)
  if (free === null) return
  const dir = await skillDir($)
  const text = await $.fs.read(`${dir}/config.local.json`).catch(() => undefined)
  const config = configOf(typeof text === 'string' ? text : undefined)
  const notified = ((await $.store.get(NOTIFIED_KEY)) ?? {}) as Record<string, number>

  if (free >= config.recoverGB * GB) {
    if (Object.keys(notified).length > 0) await $.store.set(NOTIFIED_KEY, {})
    return
  }
  if (free >= config.minFreeGB * GB) return

  const root = await repoRoot($)
  if (root === null) return
  const now = await $.clock.now()
  const last = notified[root]
  if (last !== undefined && now - last < RENOTIFY_AFTER_MS) return
  await $.store.set(NOTIFIED_KEY, { ...notified, [root]: now })

  const name = root.split(/[\\/]/).pop()
  const shared = name === config.sharedCachesRepo ? ' このリポジトリは共有のキャッシュの担当なので、それも片付ける。' : ''
  await $.prompt.submit({
    text: `[ディスクの見張り] 空きが ${(free / GB).toFixed(1)}GB で、${config.minFreeGB}GB を切った。${dir}/self-clean.md に従い、ユーザーに聞かずにこのリポジトリ（${root}）の中を片付ける。${shared}`,
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // 起動の直後はほかの処理と重なるので、少し置いてから1回測る。
    void $.clock.sleep(FIRST_CHECK_AFTER_MS).then(() => check($))
    $.clock.every(CHECK_EVERY_MS, () => {
      void check($)
    })
    return started
  })
}
