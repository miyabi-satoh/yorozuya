import { describe, expect, mock, test } from 'claude-code/testing'

import { takesInputInBash, takesInputInPowerShell } from './register'

// 鍵の土台（machine-locks skill の scripts/locks.cjs）の代わり。同じ入れ物（files）の鍵のファイルを、土台と同じ決まりで読み書きする。
// 土台そのものの決まり（取り合い・持ち主が落ちたとき・前の置き場）は locks.test.cjs が確かめる。dead は、落ちたことにするセッション。
// unknown は、持ち主が生きているかを決められない（pid の無い）セッション。
function fakeLocks(argv: string[], files: Map<string, string>, dead: Set<string>, unknown: Set<string> = new Set()) {
  const [op, , ...rest] = argv.slice(2)
  const flag = (name: string) => {
    const i = rest.indexOf(name)
    return i === -1 ? undefined : rest[i + 1]
  }
  const path = '/home/me/.claude/locks/input.json'
  const now = Number(flag('--now'))
  const session = flag('--session') ?? ''
  const root = flag('--root') ?? ''
  const sameRoot = rest.includes('--same-root')
  let raw: any
  try {
    raw = JSON.parse(files.get(path) ?? 'null')
  } catch {
    raw = null
  }
  if (!(raw && typeof raw.session === 'string' && typeof raw.root === 'string' && typeof raw.what === 'string' && typeof raw.until === 'number')) raw = null
  const alive = raw === null || unknown.has(raw.session) ? null : !dead.has(raw.session)
  const state = raw === null ? 'free' : raw.until <= now ? 'expired' : alive === false ? 'dead' : 'held'
  const lock = state === 'held' ? raw : null
  const own = (l: any) => l.session === session || (sameRoot && l.root === root)
  if (op === 'status') return { state, lock, last: raw, alive }
  if (op === 'acquire') {
    if (lock !== null && !own(lock)) return { ok: false, heldBy: lock }
    const since = lock !== null && lock.session === session && typeof lock.since === 'number' ? lock.since : now
    const placed = { resource: 'input', session, root, what: flag('--what'), since, until: now + Number(flag('--ms')) }
    files.set(path, JSON.stringify(placed))
    return { ok: true, lock: placed, previous: raw }
  }
  if (op === 'release') {
    // 同じフォルダのほかのセッションの鍵は、持ち主が生きていると分かれば外さない（locks.cjs の releasable）。
    if (raw === null || !(raw.session === session || (own(raw) && alive !== true))) return { released: null }
    files.delete(path)
    return { released: raw }
  }
  if (op === 'clear') {
    if (state !== 'expired' && state !== 'dead') return { cleared: null }
    if ((flag('--holder') !== undefined && raw.session !== flag('--holder')) || (flag('--until') !== undefined && raw.until !== Number(flag('--until')))) return { cleared: null }
    files.delete(path)
    return { cleared: raw }
  }
  if (op === 'claim') {
    const claimsPath = '/home/me/.claude/locks/input.claims.json'
    const claims = JSON.parse(files.get(claimsPath) ?? '{}')
    const key = flag('--key') ?? ''
    const keep = Number(flag('--keep-ms'))
    const kept = Object.fromEntries(Object.entries(claims).filter(([, c]: [string, any]) => typeof c?.at === 'number' && now - c.at < keep)) as Record<string, any>
    if (kept[key] !== undefined) return { claimed: false, by: kept[key].by }
    files.set(claimsPath, JSON.stringify({ ...kept, [key]: { by: session, at: now } }))
    return { claimed: true }
  }
  throw new Error(`知らない操作: ${op}`)
}

// 土台をこの入れ物で答え、通ったツール呼び出しには ok を返す。
function setUp(on: any, files: Map<string, string> = new Map(), dialog: { dead?: Set<string>; unknown?: Set<string>; noLocks?: boolean } = {}) {
  on('fs.stat', () => ({ value: { realPath: '/skills/input-takeover/mod' } }))
  on('process.run', ($: any, e: any) => {
    if (dialog.noLocks || e.argv[1] !== '/skills/input-takeover/mod/../../machine-locks/scripts/locks.cjs') return { value: { exitCode: 1, stdout: '', stderr: '' } }
    return { value: { exitCode: 0, stdout: JSON.stringify(fakeLocks(e.argv, files, (dialog.dead ??= new Set()), dialog.unknown)), stderr: '' } }
  })
  on('tool.call', () => ({ result: { text: 'ok' } }))
}

describe('入力を奪う操作', () => {
  const LOCK = '/home/me/.claude/locks/input.json'
  const ENDED = '/home/me/.claude/locks/input.ended.json'

  // 了承のダイアログ。reply は選ぶラベルで、undefined はダイアログを閉じたとき。onAsk は答えを待つ間に起きること。
  // now は時計、slept は start が待った時間（待った分だけ時計を進める）。
  // interrupted は、了承の後の待ちが中断されるとき。
  // session はこのマシンで今動いているセッション（入れ替えて、ほかのセッションの見張りを試す）。shown は会話・toast・通知に出した文。
  type Dialog = {
    reply?: string
    asked: string[]
    onAsk?: () => void
    now: number
    slept: number[]
    interrupted?: boolean
    session: string
    dead?: Set<string>
    unknown?: Set<string>
    noLocks?: boolean
    shown: { log: string[]; toast: string[]; notify: string[] }
  }

  // 同じマシンのセッションどうしが見る鍵ファイルを、テストの中の1つの入れ物で代わりにする。
  // clock を渡すと、時計と待ちは mock.clock が答える（見張りの every を進めるため）。
  function machine(on: any, files: Map<string, string>, session: string, root = '/home/me/Projects/mawok', clock?: { now: () => number }) {
    const dialog: Dialog = { reply: '始める', asked: [], now: 0, slept: [], session, shown: { log: [], toast: [], notify: [] } }
    if (clock === undefined) machineClock(on, dialog)
    on('ui.log', ($: any, e: any) => (dialog.shown.log.push(e.text), { value: undefined }))
    on('ui.toast', ($: any, e: any) => (dialog.shown.toast.push(e.text), { value: undefined }))
    on('ui.notify', ($: any, e: any) => (dialog.shown.notify.push(e.text), { value: { isSent: true, channel: 'terminal_bell' } }))
    // setUp の、どのツールにも ok を返すハンドラーより先に置く。先に登録したものが先に答えるため。
    on('tool.call', { tool: 'AskUserQuestion' }, ($: any, e: any) => {
      const question = e.questions[0].question
      dialog.asked.push(question)
      dialog.onAsk?.()
      return dialog.reply === undefined ? { deny: '閉じた' } : { result: { answers: { [question]: dialog.reply } } }
    })
    setUp(on, files, dialog)
    on('env.get', ($: any, e: any) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
    on('session.id', () => ({ value: dialog.session }))
    on('session.root', () => ({ value: root }))
    on('fs.exists', ($: any, e: any) => ({ value: files.has(e.path) }))
    on('fs.read', ($: any, e: any) => ({ value: files.get(e.path) }))
    on('fs.write', ($: any, e: any) => (files.set(e.path, e.text), { value: undefined }))
    return dialog
  }

  function machineClock(on: any, dialog: Dialog) {
    on('clock.now', () => ({ value: dialog.now }))
    on('clock.sleep', ($: any, e: any) => {
      if (dialog.interrupted) throw new Error('aborted')
      dialog.slept.push(e.ms)
      dialog.now += e.ms
      return { value: undefined }
    })
  }

  // 見張りを動かす。session.start で張った every を、時計を進めて回す。
  async function watching($: any, on: any, files: Map<string, string>, session: string, now = 0, isInteractive = true) {
    const clock = mock.clock(on, { now })
    const dialog = machine(on, files, session, '/home/me/Projects/mawok', clock)
    on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
    on('tool.register', () => ({ value: undefined }))
    on('session.end', (_: any, e: any) => ({ sessionId: e.sessionId }))
    await $.session.start({ cwd: '/', surface: isInteractive ? 'terminal' : null, isInteractive })
    // start は了承の後に5秒待つので、時計を進めて待ちを終わらせる。
    const started = async () => {
      const call = $.tool.call(start())
      await clock.advance(5000)
      return call
    }
    return { dialog, clock, started, tick: () => clock.advance(15 * 1000) }
  }

  const capture = { tool: 'Bash', command: 'screencapture -x /tmp/a.png' } as const
  const start = (minutes = 10) => ({ tool: 'mcp__input-takeover__input_takeover', action: 'start', what: 'macos-check', minutes }) as any
  const end = { tool: 'mcp__input-takeover__input_takeover', action: 'end' } as any

  test('鍵を置く前は止め、置いた後は通し、見込みの時間を過ぎたらまた止める', async ($, on) => {
    const dialog = machine(on, new Map(), 'a')
    expect((await $.tool.call(capture) as any).deny).toContain('input-takeover')

    expect((await $.tool.call(start(10)) as any).deny).toBeUndefined()
    expect((await $.tool.call(capture) as any).result?.text).toBe('ok')

    dialog.now += 11 * 60 * 1000
    expect((await $.tool.call(capture) as any).deny).toContain('start')
  })

  test('ほかのセッションの鍵が効いていれば、操作も start も止め、外れたら通す', async ($, on) => {
    const files = new Map([[LOCK, JSON.stringify({ session: 'b', root: '/home/me/Projects/weblav', what: 'e2e', until: 5 * 60 * 1000 })]])
    machine(on, files, 'a')
    const denied = (await $.tool.call(capture) as any).deny
    expect(denied).toContain('weblav')
    expect(denied).toContain('あと5分')
    expect((await $.tool.call(start()) as any).deny).toContain('weblav')

    files.set(LOCK, '{}')
    expect((await $.tool.call(start()) as any).deny).toBeUndefined()
    expect((await $.tool.call(capture) as any).result?.text).toBe('ok')
  })

  test('end で外すと、自分の操作もまた止める', async ($, on) => {
    const files = new Map<string, string>()
    machine(on, files, 'a')
    await $.tool.call(start())
    await $.tool.call(end)
    expect(files.has(LOCK)).toBe(false)
    expect((await $.tool.call(capture) as any).deny).toBeTruthy()
  })

  test('ほかのセッションの鍵は end で外さない', async ($, on) => {
    const held = JSON.stringify({ session: 'b', root: '/r', what: 'x', until: 60000 })
    const files = new Map([[LOCK, held]])
    machine(on, files, 'a')
    await $.tool.call(end)
    expect(files.get(LOCK)).toBe(held)
  })

  test('同じフォルダのセッションの鍵は、立ち上がり直した後に start と end で引き継げる', async ($, on) => {
    const files = new Map([[LOCK, JSON.stringify({ session: 'old', root: '/home/me/Projects/mawok', what: 'x', until: 60000 })]])
    machine(on, files, 'new')
    expect((await $.tool.call(capture) as any).deny).toContain('引き継')
    expect((await $.tool.call(start()) as any).deny).toBeUndefined()
    expect((await $.tool.call(capture) as any).result?.text).toBe('ok')
    await $.tool.call(end)
    expect(files.has(LOCK)).toBe(false)
  })

  test('セッションが終わると自分の鍵を外す', async ($, on) => {
    const files = new Map<string, string>()
    machine(on, files, 'a')
    on('session.end', (_: any, e: any) => ({ sessionId: e.sessionId }))
    await $.tool.call(start())
    await $.session.end({ reason: 'clear', sessionId: 'a' } as any)
    expect(files.has(LOCK)).toBe(false)
    expect(JSON.parse(files.get(ENDED) ?? '{}').a?.what).toBe('macos-check')
  })

  test('end で外すと、会話・toast・通知で使ってよいと知らせる', async ($, on) => {
    const dialog = machine(on, new Map(), 'a')
    await $.tool.call(start())
    expect(JSON.stringify(await $.tool.call(end))).toContain('もう使って大丈夫です')
    for (const shown of [dialog.shown.log, dialog.shown.toast, dialog.shown.notify]) {
      expect(shown).toEqual(['「macos-check」が終わりました。キーボードとマウスを返しました。もう使って大丈夫です。'])
    }
  })

  test('見込みの時間を過ぎた後の end でも、鍵を外して知らせる', async ($, on) => {
    const files = new Map<string, string>()
    const dialog = machine(on, files, 'a')
    await $.tool.call(start(10))
    dialog.now += 11 * 60 * 1000
    await $.tool.call(end)
    expect(dialog.shown.notify.at(-1)).toContain('もう使って大丈夫です')
    expect(files.has(LOCK)).toBe(false)
  })

  test('外す鍵が無い end は知らせない', async ($, on) => {
    const dialog = machine(on, new Map(), 'a')
    expect(JSON.stringify(await $.tool.call(end))).toContain('外す鍵は無かった')
    expect(dialog.shown.notify).toEqual([])
  })

  test('セッションが終わって外した鍵は、ほかのセッションの見張りが一度だけ知らせる', async ($, on) => {
    const files = new Map<string, string>()
    const { dialog, started, tick } = await watching($, on, files, 'a')
    await started()
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'a' } as any)
    expect((await $.tool.call(capture) as any).deny).toBeTruthy()

    dialog.session = 'b'
    await tick()
    const notice = '/home/me/Projects/mawok のセッションが終わったので、「macos-check」の鍵を外しました。キーボードとマウスを返しました。もう使って大丈夫です。'
    expect(dialog.shown).toEqual({ log: [notice], toast: [notice], notify: [notice] })
    dialog.session = 'c'
    await tick()
    expect(dialog.shown.notify).toHaveLength(1)
    // 外した鍵の記録は、鍵としては効かない。
    expect((await started() as any).deny).toBeUndefined()
  })

  test('セッションの終わりから10分を過ぎて見つけたものは知らせない', async ($, on) => {
    const files = new Map([[ENDED, JSON.stringify({ a: { root: '/r', what: 'x', until: 0, at: 0 } })]])
    const { dialog, tick } = await watching($, on, files, 'b', 10 * 60 * 1000 - 15 * 1000)
    await tick()
    expect(dialog.shown.notify).toEqual([])
  })

  test('外されずに見込みの時間を過ぎた鍵は、持ち主はすぐ、ほかのセッションは1分過ぎてから知らせ、出すのは一度だけ', async ($, on) => {
    const files = new Map([[LOCK, JSON.stringify({ session: 'a', root: '/r', what: 'x', until: 60000 })]])
    const { dialog, clock, tick } = await watching($, on, files, 'b', 45000)
    await tick() // 60 秒: 切れたところ
    await tick() // 75 秒
    expect(dialog.shown.notify).toEqual([])

    dialog.session = 'a'
    await tick()
    expect(dialog.shown.notify).toEqual(['/r の「x」の鍵が、外されないまま見込みの時間を過ぎて切れました。キーボードとマウスは使えますが、操作が続いていることもあるので、画面が止まっているのを見てから使ってください。'])

    dialog.session = 'b'
    await clock.advance(60000)
    expect(dialog.shown.notify).toHaveLength(1)
  })

  test('持ち主が落ちて見込みの時間を過ぎた鍵は、ほかのセッションが知らせる', async ($, on) => {
    const files = new Map([[LOCK, JSON.stringify({ session: 'a', root: '/r', what: 'x', until: 60000 })]])
    const { dialog, clock } = await watching($, on, files, 'b', 60000)
    await clock.advance(60000)
    expect(dialog.shown.notify).toHaveLength(1)
    // 見張りは鍵のファイルを書き換えない（同時に置かれた鍵を消さないため）。
    expect(JSON.parse(files.get(LOCK) ?? '{}').session).toBe('a')
  })

  test('ほかのセッションが知らせる前に鍵を置くときは、切れた前の鍵を先に知らせる', async ($, on) => {
    const files = new Map([[LOCK, JSON.stringify({ session: 'a', root: '/r', what: 'x', until: 0 })]])
    const { dialog, started } = await watching($, on, files, 'b')
    await started()
    expect(dialog.shown.notify).toEqual(['/r の「x」の鍵が、外されないまま見込みの時間を過ぎて切れました。キーボードとマウスは使えますが、操作が続いていることもあるので、画面が止まっているのを見てから使ってください。'])
    expect(JSON.parse(files.get(LOCK) ?? '{}').session).toBe('b')
  })

  test('時間切れの前に end で返したら、後から時間切れを知らせない', async ($, on) => {
    const files = new Map<string, string>()
    const { dialog, clock, started } = await watching($, on, files, 'a')
    await started()
    await clock.advance(10 * 60 * 1000 + 5000)
    await $.tool.call(end)
    expect(dialog.shown.notify).toHaveLength(1)
    await clock.advance(5 * 60 * 1000)
    expect(dialog.shown.notify).toHaveLength(1)
  })

  test('切れた鍵の end を繰り返しても、その後にセッションが終わっても、返したことは一度だけ知らせる', async ($, on) => {
    const files = new Map<string, string>()
    const { dialog, clock, started } = await watching($, on, files, 'a')
    await started()
    await clock.advance(10 * 60 * 1000 + 5000)
    await $.tool.call(end)
    expect(JSON.stringify(await $.tool.call(end))).toContain('外す鍵は無かった')
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'a' } as any)
    dialog.session = 'b'
    await clock.advance(60 * 1000)
    expect(dialog.shown.notify).toHaveLength(1)
  })

  test('前に終わった同じセッションの記録は、後の鍵の時間切れを隠さない', async ($, on) => {
    const files = new Map([
      [ENDED, JSON.stringify({ a: { root: '/r', what: 'old', until: 1000, at: 1000 } })],
      [LOCK, JSON.stringify({ session: 'a', root: '/r', what: 'x', until: 60000 })],
    ])
    const { dialog, clock } = await watching($, on, files, 'a', 30000)
    await clock.advance(45000)
    expect(dialog.shown.notify.at(-1)).toContain('「x」の鍵が、外されないまま')
  })

  test('終わったセッションの知らせの時に、ほかのセッションが鍵を置いていれば、使ってよいとは言わない', async ($, on) => {
    const files = new Map([
      [ENDED, JSON.stringify({ a: { root: '/r', what: 'x', until: 60000, at: 0 } })],
      [LOCK, JSON.stringify({ session: 'b', root: '/home/me/Projects/weblav', what: 'e2e', until: 5 * 60 * 1000 })],
    ])
    const { dialog, tick } = await watching($, on, files, 'c')
    await tick()
    expect(dialog.shown.notify).toEqual(['/r のセッションが終わったので、「x」の鍵を外しました。キーボードとマウスは、いま /home/me/Projects/weblav の「e2e」が使っています（あと5分の見込み）。'])
  })

  test('ほかのセッションの鍵が置かれた後で、切れた自分の鍵を end しても、その鍵を消さない', async ($, on) => {
    const files = new Map([[LOCK, JSON.stringify({ session: 'b', root: '/r', what: 'y', until: 60 * 60 * 1000 })]])
    machine(on, files, 'a')
    await $.tool.call(end)
    expect(JSON.parse(files.get(LOCK) ?? '{}').session).toBe('b')
  })

  test('見込みの時間を過ぎた鍵のままセッションが終わっても、終わったことを知らせる', async ($, on) => {
    const files = new Map<string, string>()
    const { dialog, clock, started } = await watching($, on, files, 'a')
    await started()
    await clock.advance(10 * 60 * 1000 + 15 * 1000)
    expect(dialog.shown.notify).toHaveLength(1)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'a' } as any)
    dialog.session = 'b'
    await clock.advance(15 * 1000)
    expect(dialog.shown.notify.at(-1)).toContain('セッションが終わったので')
  })

  test('切れてから10分を過ぎた鍵は、セッションが終わるときに黙って外す', async ($, on) => {
    const files = new Map<string, string>()
    const { dialog, clock, started } = await watching($, on, files, 'a')
    await started()
    await clock.advance(30 * 60 * 1000)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'a' } as any)
    expect(files.has(ENDED)).toBe(false)
    dialog.session = 'b'
    await clock.advance(15 * 1000)
    expect(dialog.shown.notify).toHaveLength(1)
  })

  test('人のいないセッション（-p）は見張らない', async ($, on) => {
    const files = new Map([[ENDED, JSON.stringify({ a: { root: '/r', what: 'x', until: 0, at: 0 } })]])
    const { dialog, tick } = await watching($, on, files, 'b', 0, false)
    await tick()
    expect(dialog.shown.notify).toEqual([])
  })

  test('効いている鍵と、鍵の無いときは知らせない', async ($, on) => {
    const files = new Map<string, string>()
    const { dialog, started, tick } = await watching($, on, files, 'a')
    await tick()
    await started()
    dialog.session = 'b'
    await tick()
    expect(dialog.shown.notify).toEqual([])
  })

  test('有限でない minutes は断る', async ($, on) => {
    const files = new Map<string, string>()
    machine(on, files, 'a')
    expect((await $.tool.call(start(Infinity)) as any).deny).toContain('minutes')
    expect(files.has(LOCK)).toBe(false)
  })

  test('壊れた鍵ファイルは無いものとみなす', async ($, on) => {
    machine(on, new Map([[LOCK, 'not json']]), 'a')
    expect((await $.tool.call(start()) as any).deny).toBeUndefined()
  })

  test('ダイアログで what と分数を問い、「始める」なら置き、ほかの答えや閉じたときは置かない', async ($, on) => {
    const files = new Map<string, string>()
    const dialog = machine(on, files, 'a')

    dialog.reply = 'やめる'
    expect((await $.tool.call(start()) as any).deny).toContain('やめる')
    expect(dialog.asked[0]).toContain('macos-check')
    expect(dialog.asked[0]).toContain('10分')

    dialog.reply = '30分後にして'
    expect((await $.tool.call(start()) as any).deny).toContain('30分後にして')

    dialog.reply = undefined
    expect((await $.tool.call(start()) as any).deny).toContain('閉じられた')
    expect(files.has(LOCK)).toBe(false)

    expect(dialog.slept).toHaveLength(0)

    dialog.reply = '始める'
    expect((await $.tool.call(start()) as any).deny).toBeUndefined()
    expect(files.has(LOCK)).toBe(true)
    // 了承の後は5秒待ってから返し、その間も鍵が効くよう、待つ分だけ長く置く。
    expect(dialog.slept).toEqual([5000])
    expect(JSON.parse(files.get(LOCK) ?? '{}').until).toBe(5000 + 10 * 60000)
    expect(dialog.asked.at(-1)).toContain('5秒後')
  })

  // ダイアログには、占有するマシンと、その間にしてよいこと・いけないことを、マシンと Deskflow の並びから出す。
  const RULES = '/home/me/.claude/input-takeover-rules.json'
  const rules = JSON.stringify({
    macos: { machine: 'desk の', user: ['共有のキーボードとマウスに触れない', 'laptop は本体のキーボードで使ってよい'], agent: ['画面の下の端の行へカーソルを送らない'] },
    linux: { machine: 'laptop の', user: ['laptop の本体に触れない'] },
  })
  const askedOn = async ($: any, on: any, platform?: string, notes?: unknown, files = new Map([[RULES, rules]])) => {
    if (platform !== undefined) on('session.info', () => ({ value: { platform } }))
    const dialog = machine(on, files, 'a')
    const call = $.tool.call({ ...start(), ...(notes === undefined ? {} : { notes }) })
    const result = (await call) as any
    return { result, question: dialog.asked[0] ?? '' }
  }

  test('設定にその OS の注意があれば、マシンの名前と注意をダイアログに出し、セッションへの注意を結果に添える', async ($, on) => {
    const { question, result } = await askedOn($, on, 'macos')
    expect(question).toContain('desk の画面・キーボード・マウス')
    expect(question).toContain('・共有のキーボードとマウスに触れない\n・laptop は本体のキーボードで使ってよい\n')
    expect(result.result).toContain('この環境の注意: 画面の下の端の行へカーソルを送らない')
  })

  test('agent の無い OS は、結果に注意を添えない', async ($, on) => {
    const { question, result } = await askedOn($, on, 'linux')
    expect(question).toContain('laptop の画面')
    expect(result.result).not.toContain('この環境の注意')
  })

  test('設定に無い OS と、設定の無い環境では、このマシンと書く', async ($, on) => {
    expect((await askedOn($, on, 'windows')).question).toContain('このマシンのキーボードとマウスに触れない')
  })

  test('OS が分からなければ、このマシンと書く', async ($, on) => {
    expect((await askedOn($, on, undefined, undefined, new Map())).question).toContain('このマシンのキーボードとマウスに触れない')
  })

  test('壊れた設定は、既定の注意だけを出し、読めなかったことを結果で伝える', async ($, on) => {
    const broken = new Map([[RULES, JSON.stringify({ macos: { machine: 'desk の', user: ['a\n・b'] } })]])
    const { question, result } = await askedOn($, on, 'macos', undefined, broken)
    expect(question).toContain('このマシンのキーボードとマウスに触れない')
    expect(result.result).toContain('input-takeover-rules.json を読めなかった')
  })

  test('notes は、マシンの注意の後に1行ずつ足す', async ($, on) => {
    const { question } = await askedOn($, on, 'macos', ['このアプリの窓に触れない'])
    expect(question).toContain('・laptop は本体のキーボードで使ってよい\n・このアプリの窓に触れない\n')
  })

  test('notes が文字列の配列でないか、改行を含めば、問わずに断る', async ($, on) => {
    const { result, question } = await askedOn($, on, 'macos', 'laptop は使ってよい')
    expect(result.deny).toContain('notes')
    expect(question).toBe('')
    expect((await $.tool.call({ ...start(), notes: ['x\n・共有のキーボードは触れてよい'] }) as any).deny).toContain('notes')
    expect((await $.tool.call({ ...start(), notes: ['x\u2028y'] }) as any).deny).toContain('notes')
  })

  test('了承のうちでも、notes のある別の what は問い、notes の無いものは問わない', async ($, on) => {
    const dialog = machine(on, new Map(), 'a')
    await $.tool.call(start())
    await $.tool.call({ ...start(), what: 'b' })
    expect(dialog.asked).toHaveLength(1)
    await $.tool.call({ ...start(), what: 'c', notes: ['Mawok の窓に触れない'] })
    expect(dialog.asked).toHaveLength(2)
    expect(dialog.asked[1]).toContain('Mawok の窓に触れない')
  })

  test('了承の後の待ちが中断されたら、鍵を外して断る', async ($, on) => {
    const files = new Map<string, string>()
    const dialog = machine(on, files, 'a')
    dialog.interrupted = true
    expect((await $.tool.call(start()) as any).deny).toContain('中断')
    expect(files.has(LOCK)).toBe(false)
    // 中断した了承は続けない。
    dialog.interrupted = false
    await $.tool.call(start())
    expect(dialog.asked).toHaveLength(2)
  })

  test('同じフォルダのほかのセッションの鍵を引き継ぐときも、問い直す', async ($, on) => {
    const files = new Map([[LOCK, JSON.stringify({ session: 'old', root: '/home/me/Projects/mawok', what: 'x', until: 60000 })]])
    const dialog = machine(on, files, 'new')
    dialog.reply = 'やめる'
    expect((await $.tool.call(start()) as any).deny).toBeTruthy()
    expect(dialog.asked).toHaveLength(1)
    expect(JSON.parse(files.get(LOCK) ?? '{}').session).toBe('old')
  })

  test('了承から10分のうちは、鍵を持ったまま別の what に移っても問わず、過ぎたら問う', async ($, on) => {
    const files = new Map<string, string>()
    const dialog = machine(on, files, 'a')
    await $.tool.call(start(20))
    expect(dialog.asked).toHaveLength(1)
    dialog.now = 2 * 60 * 1000
    await $.tool.call({ ...start(20), what: 'e2e' })
    expect(dialog.asked).toHaveLength(1)
    // 問わない置き直しでは待たず、待つ分を足さず、了承の時刻も書き換えない（使い続けても延ばさない）。
    expect(dialog.slept).toHaveLength(1)
    expect(JSON.parse(files.get(LOCK) ?? '{}').until).toBe(2 * 60 * 1000 + 20 * 60000)
    expect(JSON.parse(files.get('/home/me/.claude/locks/input.approved.json') ?? '{}')).toEqual({ a: 0 })
    // 了承の時から数え、使い続けても延ばさない（了承は 0 秒の時点、ここで 10 分ちょうど）。
    dialog.now = 10 * 60 * 1000
    await $.tool.call({ ...start(20), what: 'shoot' })
    expect(dialog.asked).toHaveLength(2)
  })

  test('end で返した後の start は、10分のうちでも同じ what でも問い直す', async ($, on) => {
    const files = new Map<string, string>()
    const dialog = machine(on, files, 'a')
    await $.tool.call(start(1))
    const ended = (await $.tool.call(end)) as any
    expect(ended.result).toContain('返答の文にも')
    dialog.now = 60 * 1000
    await $.tool.call(start(1))
    expect(dialog.asked).toHaveLength(2)
  })

  test('外されないまま見込みの時間を過ぎた後の start も、10分のうちでも問い直す', async ($, on) => {
    const dialog = machine(on, new Map(), 'a')
    await $.tool.call(start(1))
    dialog.now = 2 * 60 * 1000
    await $.tool.call({ ...start(1), what: 'shoot' })
    expect(dialog.asked).toHaveLength(2)
  })

  test('start の結果は、始めることを返答の文に書くよう促す', async ($, on) => {
    machine(on, new Map(), 'a')
    expect(((await $.tool.call(start(1))) as any).result).toContain('触らないでください')
  })

  test('自分の鍵が効いている間の同じ what の置き直しは、10分を過ぎても問わない', async ($, on) => {
    const dialog = machine(on, new Map(), 'a')
    await $.tool.call(start(30))
    dialog.now += 20 * 60 * 1000
    await $.tool.call(start(30))
    expect(dialog.asked).toHaveLength(1)
  })

  test('了承のうちでも、同じフォルダのほかのセッションの鍵を引き継ぐときは問う', async ($, on) => {
    const files = new Map([['/home/me/.claude/locks/input.approved.json', JSON.stringify({ new: 0 })]])
    files.set(LOCK, JSON.stringify({ session: 'old', root: '/home/me/Projects/mawok', what: 'x', until: 60000 }))
    const dialog = machine(on, files, 'new')
    await $.tool.call(start())
    expect(dialog.asked).toHaveLength(1)
  })

  test('壊れた了承のファイルや、未来の時刻は了承とみなさない', async ($, on) => {
    const files = new Map<string, string>()
    const dialog = machine(on, files, 'a')
    await $.tool.call(start())
    expect(dialog.asked).toHaveLength(1)
    // 鍵を持ったまま別の what に移るとき、了承のファイルが壊れているか、了承の時刻が未来なら問う。
    files.set('/home/me/.claude/locks/input.approved.json', '[1]')
    await $.tool.call({ ...start(), what: 'e2e' })
    expect(dialog.asked).toHaveLength(2)
    files.set('/home/me/.claude/locks/input.approved.json', JSON.stringify({ a: dialog.now + 60000 }))
    await $.tool.call({ ...start(), what: 'shoot' })
    expect(dialog.asked).toHaveLength(3)
  })

  test('「やめる」は続けず、次の start でまた問う', async ($, on) => {
    const files = new Map<string, string>()
    const dialog = machine(on, files, 'a')
    dialog.reply = 'やめる'
    await $.tool.call(start())
    dialog.reply = '始める'
    await $.tool.call(start())
    expect(dialog.asked).toHaveLength(2)
    expect(JSON.parse(files.get('/home/me/.claude/locks/input.approved.json') ?? '{}')).toEqual({ a: 0 })
  })

  test('答えを待つ間にほかのセッションが鍵を置いたら、上書きしない', async ($, on) => {
    const files = new Map<string, string>()
    const dialog = machine(on, files, 'a')
    const other = JSON.stringify({ session: 'b', root: '/home/me/Projects/weblav', what: 'e2e', until: 60000 })
    dialog.onAsk = () => files.set(LOCK, other)
    expect((await $.tool.call(start()) as any).deny).toContain('weblav')
    expect(files.get(LOCK)).toBe(other)
    // 断られた了承は残さない。
    expect(files.has('/home/me/.claude/locks/input.approved.json')).toBe(false)
  })

  test('引用符の中の名前や、ほかのコマンドは止めない', async ($, on) => {
    machine(on, new Map(), 'a')
    const command = 'git commit -m "screencapture を止める" && grep osascriptx file'
    expect((await $.tool.call({ tool: 'Bash', command }) as any).result?.text).toBe('ok')
  })

  test('窓か範囲を指して撮るだけの screencapture は、鍵が無くても通す', async ($, on) => {
    machine(on, new Map(), 'a')
    for (const command of [
      'screencapture -x -o -l 12345 /tmp/a.png',
      'screencapture -xol12345 /tmp/a.png',
      'screencapture -x -R0,0,100,100 /tmp/a.png',
      'id=$(node win.mjs) && screencapture -x -l "$id" /tmp/a.png',
      'screencapture -x \\\n  -l 1 -tjpg /tmp/a.jpg 2>&1',
      'screencapture -x -l 1 /tmp/a.png && cat open.log',
      'screencapture -R0,0,10,10 /tmp/open-file.png && cat notes/osascript.md',
      '(screencapture -x -l $(node win.mjs) /tmp/a.png)',
      'screencapture -x -l $(node win.mjs | head -1) /tmp/a.png',
      'screencapture -x -l $(cat $(ls /tmp/id)) /tmp/a.png',
    ]) {
      expect((await $.tool.call({ tool: 'Bash', command }) as any).result?.text).toBe('ok')
    }
  })

  test('選ばせる・開く・指さない screencapture と、open と一緒のものは止める', async ($, on) => {
    machine(on, new Map(), 'a')
    for (const command of [
      'screencapture -i /tmp/a.png',
      'screencapture -x -W -l 1 /tmp/a.png',
      'screencapture -P -l 1 /tmp/a.png',
      'screencapture -x /tmp/a.png',
      'screencapture -l 1 /tmp/a.png; screencapture -x /tmp/b.png',
      'open -a Rencon && screencapture -x -l 1 /tmp/a.png',
      'screencapture -x -l 1 /tmp/a.png && osascript -e x',
      'screencapture -x -l 1 \\\n  -i /tmp/a.png',
      'screencapture -l 1 2>&1 -P /tmp/a.png',
      'screencapture -R0,0,10,10 -s /tmp/a.png',
      'screencapture -xwl1 /tmp/a.png',
      'screencapture -l 1 -v /tmp/a.mov',
      'screencapture -x -l1 -M /tmp/a.png',
      'screencapture -l1 -u /tmp/a.png',
      'screencapture -l1 -d /tmp/a.png',
      'screencapture -x -l 1 >&- -i /tmp/a.png',
      'screencapture -l1 /tmp/a.png; open;',
      'screencapture -x -l 1 /tmp/a.png && /usr/bin/open /tmp/a.png',
      '/usr/sbin/screencapture -i /tmp/a.png',
      'screencapture -l 1 /tmp/a.png; x=`open /tmp/a.png`',
      'screencapture -l 1 /tmp/a.png && x=$(open /tmp/a.png)',
      `screencapture -l 1 "$(echo ')')" -i /tmp/a.png`,
      'screencapture -l $(node win.mjs) -i /tmp/a.png',
      'screencapture -l $(node win.mjs | head -1) -i /tmp/a.png',
      'screencapture -l `node win.mjs; echo` -i /tmp/a.png',
      'x=$(screencapture -i /tmp/a.png)',
      'x=`screencapture -x /tmp/a.png`',
      'x=$(screencapture -x -l 1 /tmp/a.png)',
      'screencapture -l $(node win.mjs | (head -1)) -i /tmp/a.png',
      'screencapture -l $(echo screencapture) -i /tmp/a.png',
      'screencapture -l $((1 + 2)) -i /tmp/a.png',
      'screencapture -l 1 <(echo x; echo y) -i /tmp/a.png',
      'screencapture -l 1 >(tee a | tee b) /tmp/a.png',
      'screencapture -l 1 -p /tmp/a.png',
    ]) {
      expect((await $.tool.call({ tool: 'Bash', command }) as any).deny).toContain('input-takeover')
    }
  })

  test('持ち主が外さずに落ちた鍵は、見込みの時刻の前でも、ほかのセッションの見張りが終わったと知らせて片付ける', async ($, on) => {
    const files = new Map([[LOCK, JSON.stringify({ session: 'a', root: '/r', what: 'x', until: 30 * 60 * 1000 })]])
    const { dialog, tick } = await watching($, on, files, 'b')
    expect((await $.tool.call(capture) as any).deny).toContain('/r')
    dialog.dead = new Set(['a'])
    await tick()
    expect(dialog.shown.notify).toEqual(['/r のセッションが終わったので、「x」の鍵を外しました。キーボードとマウスを返しました。もう使って大丈夫です。'])
    expect(files.has(LOCK)).toBe(false)
    dialog.session = 'c'
    await tick()
    expect(dialog.shown.notify).toHaveLength(1)
  })

  test('切れた後に持ち主が落ちたら、時間切れの後に終わったことも知らせる', async ($, on) => {
    const files = new Map([[LOCK, JSON.stringify({ session: 'a', root: '/r', what: 'x', until: 60000 })]])
    const { dialog, clock } = await watching($, on, files, 'b', 60000)
    await clock.advance(60000)
    expect(dialog.shown.notify.at(-1)).toContain('見込みの時間を過ぎて切れました')
    expect(files.has(LOCK)).toBe(true)
    dialog.dead = new Set(['a'])
    await clock.advance(15000)
    expect(dialog.shown.notify.at(-1)).toContain('セッションが終わったので')
    expect(files.has(LOCK)).toBe(false)
  })

  test('時間切れを知らせる前に持ち主が落ちていたら、終わったことだけを一度知らせる', async ($, on) => {
    const files = new Map([[LOCK, JSON.stringify({ session: 'a', root: '/r', what: 'x', until: 60000 })]])
    const { dialog, clock } = await watching($, on, files, 'b', 60000)
    dialog.dead = new Set(['a'])
    await clock.advance(60000)
    expect(dialog.shown.notify).toEqual(['/r のセッションが終わったので、「x」の鍵を外しました。キーボードとマウスを返しました。もう使って大丈夫です。'])
  })

  test('持ち主が生きているか分からない切れた鍵は、時間切れだけを知らせ、10分を過ぎたら片付ける', async ($, on) => {
    const files = new Map([[LOCK, JSON.stringify({ session: 'a', root: '/r', what: 'x', until: 60000 })]])
    const { dialog, clock } = await watching($, on, files, 'b', 60000)
    dialog.unknown = new Set(['a'])
    await clock.advance(60000)
    expect(dialog.shown.notify).toHaveLength(1)
    expect(files.has(LOCK)).toBe(true)
    await clock.advance(10 * 60 * 1000)
    expect(dialog.shown.notify).toHaveLength(1)
    expect(files.has(LOCK)).toBe(false)
  })

  test('同じフォルダで動いているほかのセッションの鍵は、end で外さない', async ($, on) => {
    const files = new Map([[LOCK, JSON.stringify({ session: 'other', root: '/home/me/Projects/mawok', what: 'x', until: 60000 })]])
    const dialog = machine(on, files, 'a')
    dialog.unknown = new Set()
    expect(JSON.stringify(await $.tool.call(end))).toContain('ほかのセッションの鍵')
    expect(JSON.parse(files.get(LOCK) ?? '{}').session).toBe('other')
    expect(dialog.shown.notify).toEqual([])
  })

  test('鍵の土台を呼べなければ、入力を奪う操作も start も止める', async ($, on) => {
    const dialog = machine(on, new Map(), 'a')
    dialog.noLocks = true
    expect((await $.tool.call(capture) as any).deny).toContain('machine-locks')
    expect((await $.tool.call(start()) as any).deny).toContain('machine-locks')
  })

  test('PowerShell の SendKeys を止める', async ($, on) => {
    machine(on, new Map(), 'a')
    const command = "[System.Windows.Forms.SendKeys]::SendWait('a')"
    expect((await $.tool.call({ tool: 'PowerShell', command } as any) as any).deny).toBeTruthy()
  })
})

