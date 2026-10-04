import { describe, expect, mock, test } from 'claude-code/testing'

import { IDLE_AFTER_MS, thresholdOf, versionOf } from './register'

test('閾値は config.local.json の watch.threshold、無ければ 50', () => {
  expect(thresholdOf('{"watch":{"threshold":40}}')).toBe(40)
  expect(thresholdOf('{}')).toBe(50)
  expect(thresholdOf(undefined)).toBe(50)
  expect(thresholdOf('not json')).toBe(50)
})

test('claude --version から版を取る', () => {
  expect(versionOf('2.1.290 (Claude Code)\n')).toBe('2.1.290')
  expect(versionOf('')).toBeUndefined()
})

// 使用率・入っている版・画面を決め、セッションに届いた知らせを集める。
function setUp(on: any, s: { percent?: number; tokens?: number; installed?: string; screen?: string; herdr?: boolean }) {
  const sent: string[] = []
  const runs: string[][] = []
  mock.env(on, s.herdr === false ? {} : { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' })
  on('fs.stat', () => ({ value: { realPath: '/skills/restart-sessions/mod' } }))
  on('fs.read', () => ({ value: '{"watch":{"threshold":50}}' }))
  on('session.usage', () => ({ value: { context: { percent: s.percent, tokens: s.tokens, window: 1000000 } } }))
  on('session.version', () => ({ value: { version: '2.1.289' } }))
  on('process.run', (_$: any, e: any) => {
    runs.push(e.argv)
    return e.argv[0] === 'claude'
      ? { value: { exitCode: 0, stdout: `${s.installed ?? '2.1.289'} (Claude Code)\n`, stderr: '' } }
      : { value: { exitCode: 0, stdout: s.screen ?? '', stderr: '' } }
  })
  on('prompt.submit', (_$: any, e: any) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.start', () => ({ cwd: '/w' }))
  return Object.assign(sent, { runs })
}

const turn = { answer: 'a', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't' } as const

describe('ターンの終わりの見張り', () => {
  test('閾値を超えたら、自分を再起動するよう1回だけ知らせる', async ($, on) => {
    mock.clock(on, { now: 0 })
    const sent = setUp(on, { percent: 52 })
    await $.turn.complete(turn)
    await $.turn.complete(turn)
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('OVER 52%')
    expect(sent[0]).toContain('/skills/restart-sessions/mod/../restart-self.md')
  })

  test('閾値より下なら知らせない', async ($, on) => {
    mock.clock(on, { now: 0 })
    const sent = setUp(on, { percent: 30 })
    await $.turn.complete(turn)
    expect(sent).toEqual([])
  })

  test('Claude Code の更新が入っていれば、UPDATE を1回だけ知らせる', async ($, on) => {
    mock.clock(on, { now: 0 })
    const sent = setUp(on, { percent: 10, installed: '2.1.290' })
    await $.turn.complete(turn)
    await $.turn.complete(turn)
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('UPDATE 2.1.289 → 2.1.290')
  })

  test('/goal が動いている間と、サブエージェントのターンでは知らせない', async ($, on) => {
    mock.clock(on, { now: 0 })
    const sent = setUp(on, { percent: 80, screen: '… /goal active (5m) …' })
    await $.turn.complete(turn)
    await $.turn.complete({ ...turn, agentId: 'a1' } as any)
    expect(sent).toEqual([])
  })

  test('Herdr の外では知らせない', async ($, on) => {
    mock.clock(on, { now: 0 })
    const sent = setUp(on, { percent: 80, herdr: false })
    await $.turn.complete(turn)
    expect(sent).toEqual([])
  })
})

describe('放置の /clear', () => {
  const idleRuns = (runs: string[][]) => runs.filter(argv => argv[1]?.endsWith('idle-clear-self.mjs'))

  test('最後の応答から75分たち、10万トークン以上なら、idle-clear-self.mjs を1回だけ流す', async ($, on) => {
    const sent = setUp(on, { percent: 20, tokens: 200_000 })
    const clock = mock.clock(on, { now: 0 })
    await ($.session as any).start({ source: 'startup', cwd: '/w' })
    await clock.advance(IDLE_AFTER_MS - 60_000)
    expect(idleRuns(sent.runs)).toEqual([])
    await clock.advance(120_000)
    await clock.advance(120_000)
    expect(idleRuns(sent.runs).length).toBe(1)
  })

  test('小さい会話では流さない', async ($, on) => {
    const sent = setUp(on, { percent: 5, tokens: 50_000 })
    const clock = mock.clock(on, { now: 0 })
    await ($.session as any).start({ source: 'startup', cwd: '/w' })
    await clock.advance(IDLE_AFTER_MS + 120_000)
    expect(idleRuns(sent.runs)).toEqual([])
  })
})
