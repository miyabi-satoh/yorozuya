import { describe, expect, mock, test } from 'claude-code/testing'

import { isHeavyDeny } from './register'

const DENY = 'PreToolUse:Bash hook error: CPU の空きが 4.2% で、10% を切っているため、重い処理を止めました。\nheavy-wait の mod があれば…'

// hook に止められる重い処理と、--idle で測った空きを決め、セッションに届いた知らせを集める。
function setUp(on: any, idles: number[]) {
  const sent: string[] = []
  on('fs.stat', () => ({ value: { realPath: '/skills/heavy-task/mod' } }))
  on('tool.call', () => ({ result: DENY, text: DENY, isError: true }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: `${idles.shift() ?? 0}\n`, stderr: '' } }))
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
    expect(isHeavyDeny('command not found')).toBe(false)
  })
})

describe('待ち', () => {
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
    on('process.run', () => ({ value: { exitCode: 0, stdout: '30\n', stderr: '' } }))
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
