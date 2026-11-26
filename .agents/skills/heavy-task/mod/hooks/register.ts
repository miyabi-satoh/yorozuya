import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { HeavyWaitWaiting } from '../types'

// 止められた重い処理と、止められた時刻。空くまで、または15分たつまで持つ。
const waiting = atom({ plugin: 'heavy-wait', key: 'waiting' } as const, null as HeavyWaitWaiting)

// 止めた hook（scripts/guard-heavy-commands.cjs の CPU_IDLE_MIN）と同じ線で空いたと見る。
const CPU_IDLE_MIN = 10
const CHECK_EVERY_MS = 60 * 1000
const GIVE_UP_AFTER_MS = 15 * 60 * 1000

// guard-heavy-commands.cjs が、CPU の厳しさか、ほかのセッションが重い処理を始めたところなのを理由に止めたときの書き出し。
// 実物の結果の文には、頭に「PreToolUse:Bash hook error: 」が付く。
export const isHeavyDeny = (text: unknown) =>
  typeof text === 'string' &&
  /^(PreToolUse:\w+ hook error: )?(CPU の空きが [\d.]+% で、[\d.]+% を切っているため|ほかのセッションが重い処理を始めたところなので)、重い処理を止めました/.test(text)

const commandOf = (e: unknown) => {
  const { command, script } = e as { command?: unknown; script?: unknown }
  if (typeof command === 'string') return command
  return typeof script === 'string' ? 'Workflow' : '(コマンド不明)'
}

// 止めた hook と同じ判断で測る（このスキルの scripts/guard-heavy-commands.cjs を --ready で呼ぶ）。
// 空き（測れなければ null）と、ほかのセッションが重い処理を始めたところか。どちらも分からなければ null。
// mod のフォルダーは symlink で読み込まれることがあるので、実体のパスからスキルのフォルダーを割り出す。
async function measure($: EngineInterface) {
  const { realPath } = await $.fs.stat($.plugin.root, { resolve: true })
  const { exitCode, stdout } = await $.process.run(['node', `${realPath ?? $.plugin.root}/../scripts/guard-heavy-commands.cjs`, '--ready', await $.session.id()])
  if (exitCode !== 0) return null
  try {
    const { idle, heldBy } = JSON.parse(stdout) as { idle: unknown; heldBy: unknown }
    return { idle: typeof idle === 'number' && Number.isFinite(idle) ? idle : null, starting: heldBy !== null && heldBy !== undefined }
  } catch {
    return null
  }
}

async function check($: EngineInterface) {
  const current = await read($, waiting)
  if (current === null) return
  const measured = await measure($)
  if (measured === null || measured.idle === null) return
  const { idle, starting } = measured
  const elapsed = (await $.clock.now()) - current.since
  if (idle >= CPU_IDLE_MIN && !starting) {
    await update($, waiting, () => null)
    await $.prompt.submit({
      text: `[重い処理の待ち] CPU の空きが ${idle.toFixed(1)}% に戻った。止められた次の処理を流し直してよい（heavy-task skill）。\n${current.command}`,
    })
  } else if (elapsed >= GIVE_UP_AFTER_MS) {
    await update($, waiting, () => null)
    await $.prompt.submit({
      text: `[重い処理の待ち] 15分たっても${starting ? '、ほかのセッションが重い処理を始め続けている（CPU の空きは ' + idle.toFixed(1) + '%）' : ` CPU の空きが ${idle.toFixed(1)}% のまま`}。heavy-task skill の手順どおり、待ち続けるか強行するかをユーザーに聞く。\n${current.command}`,
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
