import { describe, expect, mock, test } from 'claude-code/testing'

import { configOf, freeBytesOfDf } from './register'

const GB = 1024 ** 3
const TICK = 10 * 60 * 1000
const FIRST = 60 * 1000

const dfOf = (freeGB: number) =>
  `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 239362496 179000000 ${freeGB * 1024 * 1024} 86% /System/Volumes/Data\n`

// df が返す空きを順に決め、git が返すリポジトリを決め、セッションに届いた知らせを集める。
function setUp(on: any, frees: number[], opts: { repo?: string; config?: string; windows?: boolean } = {}) {
  const sent: string[] = []
  const store: Record<string, unknown> = {}
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('fs.stat', () => ({ value: { realPath: '/skills/cleanup/mod' } }))
  on('fs.read', () => (opts.config === undefined ? { deny: 'ENOENT' } : { value: opts.config }))
  on('env.get', (_$: any, e: any) => ({
    value: e.name === 'HOME' ? '/Users/me' : e.name === 'OS' && opts.windows ? 'Windows_NT' : undefined,
  }))
  on('process.run', (_$: any, e: any) => {
    // Windows の df（uutils）は、パスを渡しても最初のボリュームを返すことがある。
    if (e.argv[0] === 'df') return { value: { exitCode: 0, stdout: opts.windows ? dfOf(0) : dfOf(frees.shift() ?? 100), stderr: '' } }
    if (e.argv[0] === 'powershell') return { value: { exitCode: 0, stdout: `${(frees.shift() ?? 100) * GB}
`, stderr: '' } }
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: `${opts.repo ?? '/Users/me/Works/app'}/.git\n`, stderr: '' } }
    return { value: { exitCode: 1, stdout: '', stderr: '' } }
  })
  on('prompt.submit', (_$: any, e: any) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('session.start', () => ({ cwd: '/Users/me/Works/app' }))
  return sent
}

describe('configOf', () => {
  test('無ければ既定値（20GB を切ったら知らせ、30GB で戻ったとみる）', () => {
    expect(configOf(undefined)).toEqual({ minFreeGB: 20, recoverGB: 30, sharedCachesRepo: undefined })
    expect(configOf('壊れた')).toEqual({ minFreeGB: 20, recoverGB: 30, sharedCachesRepo: undefined })
  })
  test('diskWatch の値を使い、recoverGB は minFreeGB より下げない', () => {
    expect(configOf('{"diskWatch":{"minFreeGB":40,"recoverGB":10,"sharedCachesRepo":"knowledge"}}')).toEqual({
      minFreeGB: 40,
      recoverGB: 40,
      sharedCachesRepo: 'knowledge',
    })
  })
})

describe('freeBytesOfDf', () => {
  test('df -kP の Available を読む', () => {
    expect(freeBytesOfDf(dfOf(29))).toBe(29 * GB)
    expect(freeBytesOfDf('')).toBe(null)
  })
})

describe('見張り', () => {
  test('ラインを切ったら1回だけ知らせ、戻るまで知らせ直さない', async ($, on) => {
    const sent = setUp(on, [25, 25, 18, 15, 25])
    const clock = mock.clock(on, { now: 0 })
    await ($.session as any).start({ source: 'startup', cwd: '/Users/me/Works/app' })
    await clock.advance(FIRST)
    await clock.advance(TICK)
    expect(sent).toEqual([])
    await clock.advance(TICK)
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('空きが 18.0GB で、20GB を切った')
    expect(sent[0]).toContain('/skills/cleanup/self-clean.md')
    expect(sent[0]).toContain('/Users/me/Works/app')
    expect(sent[0]).not.toContain('共有のキャッシュ')
    await clock.advance(TICK)
    await clock.advance(TICK)
    expect(sent.length).toBe(1)
  })

  test('Windows では df を使わず PowerShell で測る', async ($, on) => {
    const sent = setUp(on, [25, 18], { windows: true })
    const clock = mock.clock(on, { now: 0 })
    await ($.session as any).start({ source: 'startup', cwd: '/Users/me/Works/app' })
    await clock.advance(FIRST)
    expect(sent).toEqual([])
    await clock.advance(TICK)
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('空きが 18.0GB で')
  })

  test('30GB に戻れば、次にラインを切ったときにまた知らせる', async ($, on) => {
    const sent = setUp(on, [25, 18, 31, 19])
    const clock = mock.clock(on, { now: 0 })
    await ($.session as any).start({ source: 'startup', cwd: '/Users/me/Works/app' })
    await clock.advance(FIRST)
    for (let i = 0; i < 3; i++) await clock.advance(TICK)
    expect(sent.length).toBe(2)
  })

  test('戻らないままでも、1日たてば知らせ直す', async ($, on) => {
    const sent = setUp(on, Array(200).fill(15))
    const clock = mock.clock(on, { now: 0 })
    await ($.session as any).start({ source: 'startup', cwd: '/Users/me/Works/app' })
    await clock.advance(FIRST)
    expect(sent.length).toBe(1)
    // 最初の知らせは起動の1分後。1440分の見張りではまだ1439分なので知らせず、1450分で知らせ直す。
    for (let i = 0; i < 144; i++) await clock.advance(TICK)
    expect(sent.length).toBe(1)
    await clock.advance(TICK)
    expect(sent.length).toBe(2)
  })

  test('前に知らせたときより2GB減っていれば、1時間たったところで知らせ直す', async ($, on) => {
    const sent = setUp(on, [15, ...Array(5).fill(14), 13, 13])
    const clock = mock.clock(on, { now: 0 })
    await ($.session as any).start({ source: 'startup', cwd: '/Users/me/Works/app' })
    await clock.advance(FIRST)
    expect(sent.length).toBe(1)
    // 50分までは1GB減っただけ。60分で2GB減ったが、知らせてから59分なのでまだ知らせない。
    for (let i = 0; i < 6; i++) await clock.advance(TICK)
    expect(sent.length).toBe(1)
    await clock.advance(TICK)
    expect(sent.length).toBe(2)
    expect(sent[1]).toContain('空きが 13.0GB で')
  })

  test('共有のキャッシュの担当のリポジトリには、それも片付けるよう書き添える', async ($, on) => {
    const sent = setUp(on, [25, 15], { repo: '/Users/me/Works/knowledge', config: '{"diskWatch":{"sharedCachesRepo":"knowledge"}}' })
    const clock = mock.clock(on, { now: 0 })
    await ($.session as any).start({ source: 'startup', cwd: '/Users/me/Works/knowledge' })
    await clock.advance(FIRST)
    await clock.advance(TICK)
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('共有のキャッシュの担当')
  })
})
