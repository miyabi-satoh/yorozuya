import { describe, expect, mock, test } from 'claude-code/testing'

import { IDLE_AFTER_MS, noticeRowOf, thresholdOf, versionOf } from './register'

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

const NBSP = String.fromCharCode(0xa0)

// 2.1.325 の画面（入力欄の上枠のすぐ上が知らせの行）。
const screenWith = (notice: string, body = '会話の中の Auto-update failed の話') =>
  [body, `   ${notice}`, `${'─'.repeat(20)} knowledge-f3/x1 ─`, '❯ ', '─'.repeat(30), '  Model: Opus 5.5 | Ctx Used: 10.0%', '  ⏵⏵ auto mode on'].join('\n')

test('知らせの行は、入力欄の上枠のすぐ上の1行', () => {
  expect(noticeRowOf(screenWith('✘ Auto-update failed · Run claude doctor')).trim()).toBe('✘ Auto-update failed · Run claude doctor')
  expect(noticeRowOf(screenWith(''))).not.toContain('Auto-update failed')
  expect(noticeRowOf('入力欄の無い画面')).toBe('')
  expect(noticeRowOf(screenWith('✘ Auto-update failed'))).toContain(' ')
})

// 使用率・入っている版・画面を決め、セッションに届いた知らせを集める。
function setUp(on: any, s: { percent?: number; tokens?: number; installed?: string; screen?: string; herdr?: boolean; pane?: string }) {
  const sent: string[] = []
  const runs: string[][] = []
  const env = (): Record<string, string> => (s.herdr === false ? {} : { HERDR_ENV: '1', HERDR_PANE_ID: s.pane ?? 'w1:p1' })
  on('env.get', (_$: any, e: any) => ({ value: env()[e.name] }))
  on('fs.stat', () => ({ value: { realPath: '/skills/restart-sessions/mod' } }))
  on('fs.read', () => ({ value: '{"watch":{"threshold":50}}' }))
  on('session.usage', () => ({ value: { context: { percent: s.percent, tokens: s.tokens, window: 1000000 } } }))
  on('session.version', () => ({ value: { version: '2.1.289' } }))
  const store = new Map<string, unknown>()
  on('store.get', (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_$: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('process.run', (_$: any, e: any) => {
    runs.push(e.argv)
    if (e.argv[0] === 'claude') return { value: { exitCode: 0, stdout: `${s.installed ?? '2.1.289'} (Claude Code)\n`, stderr: '' } }
    if (e.argv[1] === 'agent') {
      const agents = [{ name: 'knowledge-f3', pane_id: s.pane ?? 'w1:p1' }]
      return { value: { exitCode: 0, stdout: JSON.stringify({ result: { agents } }), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: s.screen ?? '', stderr: '' } }
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

  test('自動更新に失敗していれば、名前と版の組みごとに1回だけ再起動を知らせる（再起動で新しいペインに移っても繰り返さない）', async ($, on) => {
    mock.clock(on, { now: 0 })
    // 空白がノーブレークスペースで来る画面でも当たる。
    const s = { percent: 10, screen: screenWith(`✘${NBSP}Auto-update${NBSP}failed · Run claude doctor`), pane: 'w1:p1' }
    const sent = setUp(on, s)
    await $.turn.complete(turn)
    s.pane = 'w1:p9'
    await $.turn.complete(turn)
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('UPDATE FAILED 2.1.289')
    expect(sent[0]).toContain('restart-self.md')
  })

  test('会話の中に同じ文言があるだけなら知らせない', async ($, on) => {
    mock.clock(on, { now: 0 })
    const sent = setUp(on, { percent: 10, screen: screenWith('') })
    await $.turn.complete(turn)
    expect(sent).toEqual([])
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
