import { describe, expect, mock, test } from 'claude-code/testing'

import { isHeavyDeny } from './register'

const DENY = 'PreToolUse:Bash hook error: CPU の空きが 4.2% で、10% を切っているため、重い処理を止めました。\nheavy-wait の mod があれば…'

// hook に止められる重い処理と、--ready で測った空き（starting は、ほかのセッションが重い処理を始めたところか）を決め、セッションに届いた知らせを集める。
function setUp(on: any, idles: (number | null)[], starting: boolean[] = [], succeedsOnRetry = false) {
  const sent: string[] = []
  on('fs.stat', () => ({ value: { realPath: '/skills/heavy-task/mod' } }))
  let calls = 0
  on('tool.call', () => succeedsOnRetry && ++calls > 1 ? { result: 'ok', text: 'ok', isError: false } : { result: DENY, text: DENY, isError: true })
  on('process.run', () => ({ value: { exitCode: 0, stdout: `${JSON.stringify({ idle: idles.length > 0 ? idles.shift() : 0, heldBy: starting.shift() ? { session: 'b' } : null })}\n`, stderr: '' } }))
  on('session.id', () => ({ value: 'a' }))
  on('prompt.submit', (_$: any, e: any) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('session.start', () => ({ cwd: '/Users/me/Works/x' }))
  return sent
}

describe('isHeavyDeny', () => {
  test('hook の理由だけを見分ける', () => {
    expect(isHeavyDeny(DENY)).toBe(true)
    expect(isHeavyDeny('CPU の空きが 4.2% で、10% を切っているため、重い処理を止めました。')).toBe(true)
    expect(isHeavyDeny('echo "CPU の空きが 4.2% で、10% を切っているため、重い処理を止めました"')).toBe(false)
    expect(isHeavyDeny('PreToolUse:Bash hook error: ほかのセッションが重い処理を始めたところなので、重い処理を止めました (/p の「just ci」、あと40秒)。')).toBe(true)
    expect(isHeavyDeny('command not found')).toBe(false)
    expect(isHeavyDeny('PreToolUse:Bash hook error: 重い処理は、Herdr の別のタブで流してください。')).toBe(false)
  })
})

describe('待ち', () => {
  test('止められた処理を流し直したら、後から知らせない', async ($, on) => {
    const sent = setUp(on, [30], [], true)
    const clock = mock.clock(on, { now: 0 })
    await ($.session as any).start({ source: 'startup', cwd: '/Users/me/Works/x' })
    await $.tool.call({ tool: 'Bash', command: 'just ci' })
    await $.tool.call({ tool: 'Bash', command: 'just ci' })
    await clock.advance(60_000)
    expect(sent).toEqual([])
  })
  test('空いたら知らせる', async ($, on) => {
    const sent = setUp(on, [3, 25])
    const clock = mock.clock(on, { now: 0 })
    await ($.session as any).start({ source: 'startup', cwd: '/Users/me/Works/x' })
    await $.tool.call({ tool: 'Bash', command: 'just ci' })
    await clock.advance(60 * 1000)
    expect(sent).toEqual([])
    await clock.advance(60 * 1000)
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('空きが 25.0% に戻った')
    expect(sent[0]).toContain('just ci')
  })

  test('空いていても、ほかのセッションが始めたところなら待ち続ける', async ($, on) => {
    const sent = setUp(on, [3, 40, 40], [false, true, false])
    const clock = mock.clock(on, { now: 0 })
    await ($.session as any).start({ source: 'startup', cwd: '/Users/me/Works/x' })
    await $.tool.call({ tool: 'Bash', command: 'just ci' })
    await clock.advance(60 * 1000)
    await clock.advance(60 * 1000)
    expect(sent).toEqual([])
    await clock.advance(60 * 1000)
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('空きが 40.0% に戻った')
  })

  test('空きを測れなくても、ほかのセッションの始めたところを過ぎたら知らせる', async ($, on) => {
    const sent = setUp(on, [null, null], [true, false])
    const clock = mock.clock(on, { now: 0 })
    await ($.session as any).start({ source: 'startup', cwd: '/Users/me/Works/x' })
    await $.tool.call({ tool: 'Bash', command: 'just ci' })
    await clock.advance(60 * 1000)
    expect(sent).toEqual([])
    await clock.advance(60 * 1000)
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('測れなかった')
  })

  test('15分たっても厳しければ、ユーザーに聞くよう知らせる', async ($, on) => {
    const sent = setUp(on, Array(20).fill(2))
    const clock = mock.clock(on, { now: 0 })
    await ($.session as any).start({ source: 'startup', cwd: '/Users/me/Works/x' })
    await $.tool.call({ tool: 'Bash', command: 'just ci' })
    for (let i = 0; i < 15; i++) await clock.advance(60 * 1000)
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('15分たっても')
  })
})

describe('hook の止め方', () => {
  test('PreToolUse の hook が止めた形でも、待ちが始まる', async ($, on) => {
    const sent: string[] = []
    on('fs.stat', () => ({ value: { realPath: '/skills/heavy-task/mod' } }))
    const clock = mock.clock(on, { now: 0 })
    on('classic.PreToolUse', () => ({ deny: DENY }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: '{"idle":30,"heldBy":null}\n', stderr: '' } }))
    on('session.id', () => ({ value: 'a' }))
    on('prompt.submit', (_$: any, e: any) => {
      sent.push(e.text)
      return { text: e.text }
    })
    on('session.start', () => ({ cwd: '/Users/me/Works/x' }))
    await ($.session as any).start({ source: 'startup', cwd: '/Users/me/Works/x' })
    await $.tool.call({ tool: 'Bash', command: 'just ci' })
    await clock.advance(60 * 1000)
    expect(sent.length).toBe(1)
  })
})
