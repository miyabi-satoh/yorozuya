import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

// 見張りを始めたかはセッションの状態に持つ。読み込み直し（mod の保存・更新）で子プロセスが止まっても、session.start で立て直せる。
const isWanted = atom({ plugin: 'context-watch', key: 'isWanted' } as const, false)

// 子プロセスはモジュールの命と同じだけ生きる。読み込み直すとモジュールの変数は初めからになり、子は止まる。
let isRunning = false

async function skillDir($: EngineInterface) {
  const { realPath } = await $.fs.stat($.plugin.root, { resolve: true })
  return `${realPath ?? $.plugin.root}/..`
}

async function tell($: EngineInterface, text: string) {
  await $.prompt.submit({ text: `[コンテキストの見張り] ${text}` })
}

// 子の出力は行の途中で切れて届くことがある。前の切れ端につないで行に分け、最後の切れ端は次へ回す。
export function splitLines(rest: string, text: string) {
  const lines = (rest + text).split('\n')
  return { lines: lines.slice(0, -1).filter(line => line.trim() !== ''), rest: lines.at(-1) ?? '' }
}

// 見張りのスクリプトを走らせ、出した行を1行ずつセッションに渡す。子が終われば、そのこともセッションに知らせる。
async function watch($: EngineInterface) {
  if (isRunning) return
  isRunning = true
  const dir = await skillDir($)
  const guide = `${dir}/watch.md`
  const stream = $.process.spawn({ argv: ['node', `${dir}/scripts/watch-context.mjs`] })
  const pieces = stream[Symbol.asyncIterator]()
  let rest = ''
  let errors = ''
  let ended
  try {
    for (;;) {
      const piece = await pieces.next()
      if (piece.done) {
        ended = piece.value
        break
      }
      const { stream: pipe, text } = piece.value
      if (pipe === 'stderr') {
        errors += text
        continue
      }
      const split = splitLines(rest, text)
      rest = split.rest
      for (const line of split.lines) await tell($, `${line}\n${guide} の「知らせが来たら」に従って扱う。`)
    }
  } finally {
    isRunning = false
  }
  // シグナルで止められたのは、mod の読み直しで外から止められたとき。始めたい状態を残し、session.start のタイマーに立ち上げ直させる。
  if (ended.signal !== null) return
  // スクリプトが自分で終わったのは、設定の誤りなど。立ち上げ直しても同じなので、止めて知らせる。
  await update($, isWanted, () => false)
  await tell($, `見張りのスクリプトが終わった（終了コード ${ended.code}）。${errors.trim()}\n${guide} の「始める」からやり直すかを決める。`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'start',
      description:
        'restart-sessions のコンテキストの見張りを、このセッションの間ずっと走らせる。Monitor と違って30分で切れないので、張り直さない。知らせ（OVER・UPDATE・IDLE・WARN）は、このプラグインからのメッセージとして届く。すでに走っていれば何もしない。',
    })
    // 子プロセスは session.start の $ から立ち上げる。ツール呼び出しの中で立ち上げると、その呼び出しが終わるときに止められる。
    // ツールは始めたいことを状態に書くだけにし、このタイマーが拾って立ち上げる。
    $.clock.every(5000, () => {
      void read($, isWanted).then(wanted => {
        if (wanted) void watch($)
      })
    })
    return started
  })

  on('tool.call', { tool: 'mcp__context-watch__start' }, async $ => {
    if (isRunning) return { result: '見張りはもう走っている。' }
    await update($, isWanted, () => true)
    return { result: '見張りを始めた（数秒のうちに立ち上がる）。知らせは、このプラグインからのメッセージとして届く。' }
  })
}
