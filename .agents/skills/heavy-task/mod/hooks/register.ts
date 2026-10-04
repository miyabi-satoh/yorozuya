import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { HeavyWaitWaiting } from '../types'

// 止められた重い処理と、止められた時刻。空くまで、または15分たつまで持つ。
const waiting = atom({ plugin: 'heavy-wait', key: 'waiting' } as const, null as HeavyWaitWaiting)

const CPU_IDLE_MIN = 10
const CHECK_EVERY_MS = 60 * 1000
const GIVE_UP_AFTER_MS = 15 * 60 * 1000

// guard-heavy-commands.cjs が CPU の厳しさで止めたときの理由の書き出し。
// 実物の結果の文には、頭に「PreToolUse:Bash hook error: 」が付く。
export const isHeavyDeny = (text: unknown) => typeof text === 'string' && /^(PreToolUse:\w+ hook error: )?CPU の空きが [\d.]+% で、10% を切っているため、重い処理を止めました/.test(text)

const commandOf = (e: unknown) => {
  const { command, script } = e as { command?: unknown; script?: unknown }
  if (typeof command === 'string') return command
  return typeof script === 'string' ? 'Workflow' : '(コマンド不明)'
}

// 空きは止めた hook と同じ測り方で測る（このスキルの scripts/guard-heavy-commands.cjs を --idle で呼ぶ）。測れなければ null。
// mod のフォルダは symlink で読み込まれることがあるので、実体のパスからスキルのフォルダを割り出す。
async function measureIdle($: EngineInterface) {
  const { realPath } = await $.fs.stat($.plugin.root, { resolve: true })
  const { exitCode, stdout } = await $.process.run(['node', `${realPath ?? $.plugin.root}/../scripts/guard-heavy-commands.cjs`, '--idle'])
  const idle = Number.parseFloat(stdout)
  return exitCode === 0 && Number.isFinite(idle) ? idle : null
}

async function check($: EngineInterface) {
  const current = await read($, waiting)
  if (current === null) return
  const idle = await measureIdle($)
  if (idle === null) return
  const elapsed = (await $.clock.now()) - current.since
  if (idle >= CPU_IDLE_MIN) {
    await update($, waiting, () => null)
    await $.prompt.submit({
      text: `[重い処理の待ち] CPU の空きが ${idle.toFixed(1)}% に戻った。止められた次の処理を流し直してよい（heavy-task skill）。\n${current.command}`,
    })
  } else if (elapsed >= GIVE_UP_AFTER_MS) {
    await update($, waiting, () => null)
    await $.prompt.submit({
      text: `[重い処理の待ち] 15分たっても CPU の空きが ${idle.toFixed(1)}% のまま。heavy-task skill の手順どおり、待ち続けるか強行するかをユーザーに聞く。\n${current.command}`,
    })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    $.clock.every(CHECK_EVERY_MS, () => {
      void check($)
    })
    return started
  })

  // 止めるのは hook。ここでは止められたのを見て、待ちを始める。
  on('tool.call', { tool: /^(Bash|PowerShell|Workflow)$/ }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined && result.isError === true && isHeavyDeny(result.text)) {
      const command = commandOf(e)
      const since = await $.clock.now()
      await update($, waiting, current => current ?? { command, since })
    }
    return result
  })
}
