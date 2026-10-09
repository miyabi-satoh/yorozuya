import type { EngineInterface, Register } from 'claude-code'

// 各セッションがディスクの空きを測り、ラインを切ったら、自分のリポジトリを片付けるよう自分に知らせる。
// 片付けるのは持ち主のセッション自身なので、使用中かどうかを外から推し量らずに済む。
// 知らせたリポジトリは、セッションをまたぐ $.store に持つ。同じリポジトリを開く複数のセッションのうち1つだけに知らせ、
// 空きが戻るまでは、前に知らせたときより空きが減ったときか、1日たったときだけ知らせ直す。
// 時間だけで頻繁に知らせ直すと、空きを食っているのがリポジトリの外のとき、片付けのたびに Rust の dev の成果物が消えて作り直しになる。

const GB = 1024 ** 3
const DEFAULT_MIN_FREE_GB = 20
const DEFAULT_RECOVER_GB = 30
const FIRST_CHECK_AFTER_MS = 60 * 1000
const CHECK_EVERY_MS = 10 * 60 * 1000
export const RENOTIFY_AFTER_MS = 24 * 60 * 60 * 1000
// 片付けた後も空きが減り続けるときは、新しく溜まった分を早めに片付けさせる。間を1時間置くのは、ビルドの途中の一時的な減りで続けて知らせないため。
export const RENOTIFY_ON_DROP_AFTER_MS = 60 * 60 * 1000
// ビルド1回分の揺れでは知らせ直さない大きさ。
export const RENOTIFY_ON_DROP_GB = 2
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
// Windows では df を使わない。uutils の df は、パスを渡しても最初のボリューム（EFI の領域など）を返すことがあるため。
async function measureFree($: EngineInterface) {
  if ((await $.env.get('OS')) === 'Windows_NT') {
    const ps = await $.process
      .run(['powershell', '-NoProfile', '-Command', '(Get-Item $env:USERPROFILE).PSDrive.Free'])
      .catch(() => undefined)
    const out = ps?.stdout.trim()
    const free = Number(out)
    return ps?.exitCode === 0 && out && Number.isFinite(free) ? free : null
  }
  const home = (await $.env.get('HOME')) ?? (await $.session.cwd())
  const df = await $.process.run(['df', '-kP', home]).catch(() => undefined)
  return df?.exitCode === 0 ? freeBytesOfDf(df.stdout) : null
}

// リポジトリの元の clone のパス。worktree からも同じになるので、同じリポジトリのセッションを1つにまとめられる。
async function repoRoot($: EngineInterface) {
  const { exitCode, stdout } = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (exitCode !== 0) return null
  return stdout.trim().replace(/[\\/]\.git[\\/]?$/, '') || null
}

// 前の版は知らせた時刻だけを数で持っていた。その形は空きが分からないので、時間だけで判断する。
type Notified = number | { at: number; free: number }

export function shouldNotify(last: Notified | undefined, now: number, free: number) {
  if (last === undefined) return true
  const { at, free: lastFree } = typeof last === 'number' ? { at: last, free: undefined } : last
  if (now - at >= RENOTIFY_AFTER_MS) return true
  return lastFree !== undefined && now - at >= RENOTIFY_ON_DROP_AFTER_MS && lastFree - free >= RENOTIFY_ON_DROP_GB * GB
}

export async function check($: EngineInterface) {
  const free = await measureFree($)
  if (free === null) return
  const dir = await skillDir($)
  const text = await $.fs.read(`${dir}/config.local.json`).catch(() => undefined)
  const config = configOf(typeof text === 'string' ? text : undefined)
  const notified = ((await $.store.get(NOTIFIED_KEY)) ?? {}) as Record<string, Notified>

  if (free >= config.recoverGB * GB) {
    if (Object.keys(notified).length > 0) await $.store.set(NOTIFIED_KEY, {})
    return
  }
  if (free >= config.minFreeGB * GB) return

  const root = await repoRoot($)
  if (root === null) return
  const now = await $.clock.now()
  if (!shouldNotify(notified[root], now, free)) return
  await $.store.set(NOTIFIED_KEY, { ...notified, [root]: { at: now, free } })

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
