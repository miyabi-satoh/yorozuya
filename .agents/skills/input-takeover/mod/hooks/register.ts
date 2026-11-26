import type { EngineInterface, Register } from 'claude-code'

// キーボード・マウス・フォーカスを奪う操作。Bash は引用符の外のコマンド名、PowerShell は使う API で見分ける。
// heredoc の本文は見る。`bash <<EOF`・`ssh host <<EOF` の本文は実行されるので、見ないと素通りになる。
// screencapture は、窓（-l）か範囲（-R）を指して撮るだけなら、ポインタもキーもフォーカスも使わないので止めない。
// 指さない形（クリックを待つことがある）と、CAPTURE_TAKES_FOCUS の選択肢を付けた形は止める。
// 同じコマンドで open を流すときは、窓を前に出してフォーカスを奪うので止める。
export const takesInputInBash = (command: string) => {
  // 行末の \ で続けた行は1つのコマンドなので、つないでから読む。2>&1 などの & で引数の読み取りを切らないよう、リダイレクトは外す。
  const bare = command.replace(BASH_QUOTED, "''").replace(/\\\n/g, ' ').replace(/\d*>&(?:\d+|-)|&>>?/g, ' ')
  // 語の頭から、/usr/bin/open のようなパスを挟んで名前が来て、名前の後が区切りの形だけを拾う。
  // osascript.md・open.log のような語は、その道具を流していない。
  const named = (names: string, rest = '') => new RegExp(`(?:^|[\\s;&|(\`])(?:\\S*/)?(?:${names})(?=[\\s;&|)]|$)${rest}`, 'gm')
  if (named('osascript|cliclick|xdotool').test(bare)) return true
  if (!named('screencapture').test(bare)) return false
  if (named('open').test(bare)) return true
  // -l $(node win.mjs | head -1) のように、値を作る置き換えの中の | や ; で引数の読み取りを切らないよう、
  // 置き換えは内側から1語に縮めてから読む。縮めきれない形（中に括弧がある・閉じていない）と、
  // 置き換えの中で screencapture を流す形は、引数を読み違えうるので止める側に倒す。
  let flat = bare
  let nested = false
  for (let prev = ''; prev !== flat; ) {
    prev = flat
    flat = flat.replace(/\$\(([^()]*)\)|`([^`]*)`/g, (match, inner = '', ticked = '') => {
      if (named('screencapture').test(inner || ticked)) nested = true
      return 'X'
    })
  }
  // <(…)・>(…) も中の区切りで引数を切るので、含むものは止める側に倒す。
  if (nested || /\$\(|`|[<>]\(/.test(flat)) return true
  // 引数は ) で切らない（読みすぎても、止める側に倒れるだけ）。
  const captures = [...flat.matchAll(named('screencapture', '([^;&|\\n]*)'))]
  return captures.some(([, args]) => !capturesWithoutInput(args ?? ''))
}

// screencapture -h の選択肢のうち、選ばせる（-i・-w・-s・-W・-J・-U）、撮った後に開く・画面を出す（-P・-B・-M・-u・-d）、
// 録画（-v。止めるまで画面を使い続ける）、利用者の既定の設定で撮る（-p。撮った後の小窓や開く先がその設定しだい）もの。
const CAPTURE_TAKES_FOCUS = /[iwsWJUPBMudvp]/
// 値を続けて書く選択肢（-l123・-R0,0,10,10・-tpng など）。そこから後の文字は値なので、選択肢として読まない。
// 値を取る -B・-J は、CAPTURE_TAKES_FOCUS で先に止まるので入れない。
const CAPTURE_WITH_VALUE = /[lRDtTVG]/

function capturesWithoutInput(args: string) {
  let target = false
  for (const word of args.split(/\s+/)) {
    if (!/^-[a-zA-Z]/.test(word)) continue
    for (const letter of word.slice(1)) {
      if (CAPTURE_TAKES_FOCUS.test(letter)) return false
      if (letter === 'l' || letter === 'R') target = true
      if (CAPTURE_WITH_VALUE.test(letter)) break
    }
  }
  return target
}
export const takesInputInPowerShell = (command: string) => /SendKeys|System\.Windows\.Automation|UIAutomation/i.test(command)

// 引用符の中（コミットメッセージなど）は見ない。
const BASH_QUOTED = /'[^']*'|"(?:\\.|[^"\\])*"/g

// 鍵は machine-locks skill の土台（scripts/locks.cjs）が、同じマシンのセッションどうしで取り合う「input」の鍵。
// 持ち主が外さずに落ちても、見込みの時刻（until）を過ぎるか、持ち主の Claude Code のプロセスが無くなれば外れたとみなす。
// mod の $.fs には、排他で作る API も消す API も無いので、置く・外すは土台のスクリプトに任せる。
type InputLock = { session: string; root: string; what: string; since?: number; until: number; legacy?: boolean }
type LockState = 'free' | 'held' | 'expired' | 'dead'
type Status = { state: LockState; lock: InputLock | null; last: InputLock | null; alive: boolean | null }

const TOOL = 'mcp__input-takeover__input_takeover'

// 土台は同じリポジトリの隣の skill にある。mod のフォルダーは symlink で読み込まれることがあるので、実体のパスから割り出す。
// 呼ぶ側の時計（$.clock）を渡し、テストと実物で同じ時刻で決める。
async function locks($: EngineInterface, args: string[], session?: string) {
  const { realPath } = await $.fs.stat($.plugin.root, { resolve: true })
  const cli = `${realPath ?? $.plugin.root}/../../machine-locks/scripts/locks.cjs`
  const argv = ['node', cli, ...args, '--now', String(await $.clock.now()), '--session', session ?? (await $.session.id()), '--root', await $.session.root()]
  const { exitCode, stdout, stderr } = await $.process.run(argv)
  if (exitCode !== 0) throw new Error(`鍵の土台（machine-locks skill の scripts/locks.cjs）が ${exitCode} で終わった: ${stderr.trim()}`)
  return JSON.parse(stdout) as unknown
}

const lockStatus = async ($: EngineInterface) => (await locks($, ['status', 'input'])) as Status
const effectiveLock = async ($: EngineInterface) => (await lockStatus($)).lock ?? undefined

// 鍵を置く前に、ユーザーに AskUserQuestion のダイアログで了承を取る（input-takeover skill の手順1）。画面とフォーカスを奪うので、ユーザーが手を離せる時機をユーザーが決める。
// 返答の文で問うのでなくダイアログにするのは、ダイアログなら通知が飛び、席を外していても気づけるため。
// 問いは start の中で出すので、伝えた操作（what）と了承がずれず、ほかのセッションの知らせを了承と取り違えることもない。
const APPROVE = '始める'
// 了承してから始まるまでの間。ダイアログに答えた手を離す時間を取る。
// $.clock の待ちは hook の持ち時間（10秒）に数えられ、超えると start が打ち切られるので、それより短くする。
const GRACE_MS = 5000
// 了承は、セッションごとに了承した時から10分続け、その間に自分の鍵が効いていれば、別の what に移る start も問わない（notes のある別の what は除く。使い続けても延ばさない）。
// 1つの作業で鍵を持ったまま別の操作に移るたびに問うと、了承が多すぎるため。「やめる」は続けない（次の start でまた問う）。
// ADR: 鍵が効いていない start（end で返した後・見込みの時間を過ぎて切れた後）は、10分のうちでも問う。どちらも mod がユーザーに使ってよいと知らせており、手元の操作に戻ったユーザーから黙って取り直すと、いつ触ってよいかが分からなくなるため。
const APPROVAL_TTL_MS = 10 * 60 * 1000

type Platform = 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown'
// 占有の間にユーザーがしてよいこと・いけないこと（user）と、自動操作をするセッションへの注意（agent）。マシンや入力の共有の仕方で変わるので、環境ごとに書く。
// ADR: 環境ごとの注意は、ホームの下の設定ファイル（RULES_FILE）から読む。どの環境でも使える作りは公開し、環境に固有の並び（キーボードとマウスをほかのマシンと共有しているなど）は利用者が持つため。
type MachineRules = { machine: string; user: string[]; agent: string[] }
const RULES_FILE = 'input-takeover-rules.json'
const DEFAULT_RULES: MachineRules = { machine: 'このマシンの', user: ['このマシンのキーボードとマウスに触れない'], agent: [] }

// 1要素が改行の無い1行の文字列の配列か。改行を通すと、行頭の「・」を偽った行を足せてしまう。
const isLines = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(line => typeof line === 'string' && line !== '' && !/[\r\n\v\f\u0085\u2028\u2029]/.test(line))

// 設定が無い・読めない・形が違うときは、既定の注意だけを出す（読めないことはセッションに伝える）。
async function machineRules($: EngineInterface, platform: Platform): Promise<{ rules: MachineRules; problem?: string }> {
  const path = `${await homeDir($)}/.claude/${RULES_FILE}`
  if (!(await $.fs.exists(path))) return { rules: DEFAULT_RULES }
  try {
    const all = JSON.parse((await $.fs.read(path)) as string) as Record<string, unknown>
    const entry = (all?.[platform] ?? all?.['default']) as Partial<MachineRules> | undefined
    if (entry === undefined) return { rules: DEFAULT_RULES }
    const user = entry.user ?? DEFAULT_RULES.user
    const agent = entry.agent ?? []
    if (typeof entry.machine !== 'string' || !isLines(user) || !isLines(agent)) throw new Error('machine は文字列、user と agent は1行ずつの文字列の配列で書く')
    return { rules: { machine: entry.machine, user, agent } }
  } catch (error) {
    return { rules: DEFAULT_RULES, problem: `~/.claude/${RULES_FILE} を読めなかったので、既定の注意だけを出した（${String(error)}）。` }
  }
}

const askApproval = (what: string, minutes: number, rules: MachineRules, notes: string[]) =>
  [
    `「${what}」で、${rules.machine}画面・キーボード・マウスを${minutes}分ほど使います（${GRACE_MS / 1000}秒後に始めます）。その間:`,
    ...[...rules.user, ...notes].map(rule => `・${rule}`),
    `始めてよいですか？（始めると、返すまでの${APPROVAL_TTL_MS / 60000}分のうちは、別の操作に移るときも聞きません。返した後・時間切れの後と、作業に限った注意があるときは聞きます）`,
  ].join('\n')

async function platformOf($: EngineInterface): Promise<Platform> {
  try {
    return (await $.session.info()).platform ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
const declined = (answer: string) =>
  answer === ''
    ? 'ダイアログが閉じられたか、問えなかった（-p で動いているなど）ので、鍵を置きませんでした。始めずに、ユーザーの指示を待ってください。'
    : `ユーザーが「${APPROVE}」を選ばなかったので、鍵を置きませんでした。始めずに、ユーザーの指示を待ってください（答えに時機や条件があれば、それに従う）。ユーザーの答え: ${answer}`

// Windows は USERPROFILE を先に見る。Git Bash から継いだ HOME は /c/Users/... の形で、そのままでは開けない。
async function homeDir($: EngineInterface) {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  return home.replace(/\\/g, '/').replace(/\/+$/, '')
}

// 鍵の隣に置く、この mod だけが使う記録（了承・終わったセッションの鍵）と、土台が書く知らせの札（claims）。
// 了承と終わりの記録は、読んでから書くまでにほかのセッションに消されても、問い直すか、終わりの hook の書き直しで済む。
async function recordPath($: EngineInterface, name: 'approved' | 'ended' | 'claims') {
  return `${await homeDir($)}/.claude/locks/input.${name}.json`
}

// 読めない・壊れているときは空とみなす。
async function readRecord<T>($: EngineInterface, path: string): Promise<Record<string, T>> {
  if (!(await $.fs.exists(path))) return {}
  try {
    const parsed = JSON.parse((await $.fs.read(path)) as string)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, T>) : {}
  } catch {
    return {}
  }
}

// 時計が戻って未来の時刻が残っても、了承と見なさない。
const isFresh = (approvedAt: unknown, now: number) => typeof approvedAt === 'number' && now - approvedAt >= 0 && now - approvedAt < APPROVAL_TTL_MS

async function isApproved($: EngineInterface, session: string) {
  return isFresh((await readRecord<number>($, await recordPath($, 'approved')))[session], await $.clock.now())
}

// 期限を過ぎた分は書くときに落とし、ファイルが膨らまないようにする。
// 書けなくても鍵は置く。次の start でまた問うだけになる。
async function recordApproval($: EngineInterface, session: string, approvedAt: number) {
  try {
    const now = await $.clock.now()
    const path = await recordPath($, 'approved')
    const kept = Object.fromEntries(Object.entries(await readRecord<number>($, path)).filter(([, at]) => isFresh(at, now)))
    await $.fs.write(path, JSON.stringify({ ...kept, [session]: approvedAt }))
  } catch {
    // 上のとおり。
  }
}

// 鍵が外れたら・切れたら、すぐユーザーに知らせる。ユーザーは、いつ手元の操作に戻ってよいかを自分では知れないため。
// 会話の1行に加え、toast と OS の通知も出す。自動操作の間、ユーザーはそのペインを見ていない・席を外していることが多いため。
// 書く文は、skill に頼らず mod が出す（外す経路のどれでも漏れないように）。
const NOTICE_TITLE = 'キーボードとマウス'
const RETURNED = 'キーボードとマウスを返しました。もう使って大丈夫です。'
// 返した後に、ほかのセッションがもう鍵を置いていれば、使ってよいとは言わず、その操作の途中だと伝える。
const inUseBy = (lock: InputLock, now: number) =>
  `キーボードとマウスは、いま ${lock.root} の「${lock.what}」が使っています（あと${Math.ceil((lock.until - now) / 60000)}分の見込み）。`
async function afterReturn($: EngineInterface, session: string) {
  const held = await effectiveLock($)
  return held === undefined || held.session === session ? RETURNED : inUseBy(held, await $.clock.now())
}
const returnedNotice = (what: string, after: string) => `「${what}」が終わりました。${after}`
const sessionEndedNotice = (what: string, root: string, after: string) => `${root} のセッションが終わったので、「${what}」の鍵を外しました。${after}`
const expiredNotice = (what: string, root: string) =>
  `${root} の「${what}」の鍵が、外されないまま見込みの時間を過ぎて切れました。キーボードとマウスは使えますが、操作が続いていることもあるので、画面が止まっているのを見てから使ってください。`

async function announce($: EngineInterface, text: string) {
  $.ui.log(text)
  $.ui.toast(text, { timeoutMs: 15000 })
  // 通知が切ってある・出せない環境では、会話と toast だけになる。
  await $.ui.notify(text, { title: NOTICE_TITLE }).catch(() => undefined)
}

// 持ち主が見ていられない終わり方（セッションの終わり・落ちた・見込みの時間切れ）は、同じマシンのセッションが鍵を見張って知らせる。
// セッションが終わるときは通知を出せず（$.ui.notify が exiting で出ない）、落ちたときは終わりの hook も走らないため。
// 持ち主が生きていれば、時間切れは持ち主がすぐ知らせ、ほかのセッションは OTHERS_WAIT_MS 待ってから知らせる（持ち主のペインに出るほうが分かりやすい）。
// NOTICE_WINDOW_MS より古いものは知らせない（しばらく誰もいなかった後に立ち上がったセッションが、古い話を出さないように）。
const WATCH_MS = 15 * 1000
const OTHERS_WAIT_MS = 60 * 1000
const NOTICE_WINDOW_MS = 10 * 60 * 1000

// NOTICE_WINDOW_MS を過ぎた分は書くときに落とし、ファイルが膨らまないようにする。
const keepFresh = <T extends { at: number }>(record: Record<string, T>, now: number) =>
  Object.fromEntries(Object.entries(record).filter(([, r]) => typeof r?.at === 'number' && now - r.at < NOTICE_WINDOW_MS))

// セッションが終わって外した鍵。キーは終わったセッション。until はその鍵の見込みの時刻で、どの鍵の終わりかを見分ける。
// 同時に終わったセッションの書き込みで消えたら、一度だけ書き直す。
type Ended = { root: string; what: string; until: number; at: number }
async function recordEnded($: EngineInterface, lock: InputLock) {
  const path = await recordPath($, 'ended')
  for (let i = 0; i < 2; i++) {
    const now = await $.clock.now()
    await $.fs.write(path, JSON.stringify({ ...keepFresh(await readRecord<Ended>($, path), now), [lock.session]: { root: lock.root, what: lock.what, until: lock.until, at: now } }))
    if ((await readRecord<Ended>($, path))[lock.session]?.until === lock.until) return
  }
  $.ui.log(`input-takeover: 終わった鍵の記録を書けなかった（${lock.what}）`, { to: 'debug' })
}

// 同じ知らせを出すのは1つのセッションだけにする。札は土台が取り合いの順番の中で取るので、同時に取りに来ても1つだけが取れる。
// 取った札は NOTICE_WINDOW_MS のあいだ覚える。取られた札は、土台を呼ばずにファイルで見て済ませる（見張りは15秒ごとに走るため）。
async function claimNotice($: EngineInterface, key: string, session: string) {
  if (await hasNoticed($, key)) return false
  const { claimed } = (await locks($, ['claim', 'input', '--key', key, '--keep-ms', String(NOTICE_WINDOW_MS)], session)) as { claimed: boolean }
  return claimed
}

const expiredKey = (lock: InputLock) => `expired:${lock.session}:${lock.until}`
// 返したことを知らせた鍵。二度目の end やセッションの終わりで、また知らせないよう覚える。
const returnedKey = (lock: InputLock) => `returned:${lock.session}:${lock.until}`
// 持ち主のセッションが終わった鍵。終わりの hook が記録したものも、落ちて見つかったものも、同じ鍵で一度だけ知らせる。
const endedKey = (lock: { until: number }, session: string) => `ended:${session}:${lock.until}`
// 札の記録には古いものが残りうる（書くときにしか落とさない）ので、NOTICE_WINDOW_MS より古い札は取られていないものとみなす（土台と同じ）。
const hasNoticed = async ($: EngineInterface, key: string) => {
  const at = (await readRecord<{ at?: unknown }>($, await recordPath($, 'claims')))[key]?.at
  return typeof at === 'number' && (await $.clock.now()) - at < NOTICE_WINDOW_MS
}

// 外されないまま見込みの時間を過ぎた鍵を知らせる。
// hasWaited は、ほかのセッションの時間切れを待たずに知らせるか。start が上書きする前は、待つと知らせが消えるので待たない。
async function noticeExpired($: EngineInterface, lock: InputLock, options: { hasWaited?: boolean } = {}) {
  const now = await $.clock.now()
  const session = await $.session.id()
  const late = now - lock.until
  if (late < 0 || late >= NOTICE_WINDOW_MS) return
  if (lock.session !== session && late < OTHERS_WAIT_MS && !options.hasWaited) return
  // 持ち主のセッションが終わっていれば、時間切れでなく終わったことを知らせる（下の watch）。
  if ((await readRecord<Ended>($, await recordPath($, 'ended')))[lock.session]?.until === lock.until) return
  if (await claimNotice($, expiredKey(lock), session)) await announce($, expiredNotice(lock.what, lock.root))
}

// 持ち主のセッションが外さずに落ちた鍵を知らせる。終わりの hook が走らなかったときにだけ見つかる。
async function noticeDead($: EngineInterface, lock: InputLock) {
  const session = await $.session.id()
  if (await claimNotice($, endedKey(lock, lock.session), session)) await announce($, sessionEndedNotice(lock.what, lock.root, await afterReturn($, session)))
}

// 置かれたままの鍵（切れたもの・持ち主が落ちたもの）の終わりを知らせ、終わりを知らせ終えたものは片付ける。
// 切れた鍵は、持ち主が生きている間は残す。時間切れ（操作が続いているかもしれない）の後に、持ち主が終わったことを知らせるため（終わりの hook が記録するか、落ちたのを見つける）。
async function noticeLast($: EngineInterface, status: Status, options: { hasWaited?: boolean } = {}) {
  const last = status.last
  if (last === null || last.legacy || (status.state !== 'expired' && status.state !== 'dead')) return
  const late = (await $.clock.now()) - last.until
  if (status.alive === false) {
    // 時間切れを知らせる前に落ちていたら、終わったことだけを知らせる（同じ出来事を2つ続けて知らせないため）。
    if (status.state === 'expired') await claimNotice($, expiredKey(last), await $.session.id())
    // 切れてから NOTICE_WINDOW_MS を過ぎて落ちたものは、古い話なので知らせずに片付ける。
    if (status.state === 'dead' || late < NOTICE_WINDOW_MS) await noticeDead($, last)
  } else if (status.state === 'expired') {
    await noticeExpired($, last, options)
  }
  // 片付けると見張りが土台を呼ばずに済む（見張りは鍵のファイルがあるときだけ土台を呼ぶ）。知らせた鍵だけを消す。
  if (status.alive === false || late >= NOTICE_WINDOW_MS) await locks($, ['clear', 'input', '--holder', last.session, '--until', String(last.until)])
}

async function watch($: EngineInterface) {
  const now = await $.clock.now()
  const session = await $.session.id()
  for (const [ended, lock] of Object.entries(await readRecord<Ended>($, await recordPath($, 'ended')))) {
    if (typeof lock?.at !== 'number' || now - lock.at >= NOTICE_WINDOW_MS) continue
    if (await claimNotice($, endedKey(lock, ended), session)) await announce($, sessionEndedNotice(lock.what, lock.root, await afterReturn($, session)))
  }
  // 鍵のファイルが無いときは、土台を呼ばない（見張りは15秒ごとに、同じマシンのセッションの数だけ走るため）。
  if (await $.fs.exists(`${await homeDir($)}/.claude/locks/input.json`)) await noticeLast($, await lockStatus($))
}

// 同じフォルダのセッションの鍵は、立ち上がり直す前の自分のものとみなし、start と end で引き継がせる。
// 立ち上がり直すとセッションの id が変わり、前身の鍵を外すことも延ばすこともできなくなるため。
const isOwn = (lock: InputLock, session: string, root: string) => lock.session === session || lock.root === root

const START_FIRST = `キーボード・マウス・フォーカスを奪う操作です。input-takeover skill を読み、${TOOL} を { action: "start", what: 何をするか, minutes: 見込みの分 } で呼んで鍵を置いてから、もう一度実行してください（自分の鍵の見込みの時間を過ぎたときも置き直します）。`

// ほかのセッションの鍵の持ち主と残りの分。
async function describeLock($: EngineInterface, lock: InputLock) {
  const minutes = Math.ceil((lock.until - (await $.clock.now())) / 60000)
  return `${lock.root} の「${lock.what}」、あと${minutes}分の見込み`
}

async function heldByMessage($: EngineInterface, lock: InputLock) {
  const held = await describeLock($, lock)
  if (lock.root === (await $.session.root())) {
    return `このフォルダのセッションが置いた鍵が効いています（${held}）。立ち上がり直す前の自分の鍵なら、${TOOL} の start を呼び直して引き継いでから、流し直してください。`
  }
  return `ほかのセッションが、入力を奪う操作の途中です（${held}）。同時に動かすと、クリックや入力が互いの窓に入って両方とも失敗します。鍵が外れるか見込みの時間を過ぎてから、${TOOL} の start で鍵を置いて流し直してください。`
}

// 自分の鍵が効いていれば通す。土台を呼べなければ止める（鍵を確かめられないまま入力を奪わない）。
async function checkInputTakeover($: EngineInterface) {
  let lock: InputLock | undefined
  try {
    lock = await effectiveLock($)
  } catch (error) {
    return `入力の鍵を確かめられないので止めました。${String(error)}。yorozuya を pull し直すか、machine-locks skill が input-takeover skill の隣にあるかを確かめてください。`
  }
  if (lock === undefined) return START_FIRST
  return lock.session === (await $.session.id()) ? undefined : heldByMessage($, lock)
}

async function start($: EngineInterface, input: { what?: unknown; minutes?: unknown; notes?: unknown }, signal: AbortSignal | undefined) {
  const { what, minutes, notes } = input
  const session = await $.session.id()
  const root = await $.session.root()
  if (typeof what !== 'string' || what === '' || typeof minutes !== 'number' || !Number.isFinite(minutes) || !(minutes > 0)) {
    return { deny: 'start には what（何をするか）と minutes（見込みの分、正の数）が要ります。' }
  }
  if (notes !== undefined && !isLines(notes)) return { deny: 'notes は、ダイアログに足す注意の文の配列です（1つの要素が改行の無い1行）。' }
  const hasNotes = Array.isArray(notes) && notes.length > 0
  const status = await lockStatus($)
  const held = status.lock ?? undefined
  if (held !== undefined && !isOwn(held, session, root)) return { deny: await heldByMessage($, held) }
  // 問わないのは、このセッションの鍵が効いているときだけ。同じ what の置き直しは、了承を受けた操作が延びたときなので問わない。別の what は、了承から APPROVAL_TTL_MS のうちなら問わない。
  // 効いている鍵が無ければ（end で返した後・切れた後）、了承のうちでも問う（上の APPROVAL_TTL_MS の ADR）。了承の記録は消さず、この条件で問い直させる。
  // 同じフォルダのほかのセッションの鍵（立ち上がり直す前の自分か、同じフォルダで動くほかのセッション）の引き継ぎには、了承のうちでも取り直す。そのセッションのユーザーの操作の最中かもしれないため。
  const takesOver = held !== undefined && held.session !== session
  // notes のある別の what は、了承のうちでも問う。作業に限った注意は、問わなければユーザーに届かないため。
  const asks = takesOver || held === undefined || (held.what !== what && (hasNotes || !(await isApproved($, session))))
  const { rules, problem } = await machineRules($, await platformOf($))
  let approvedAt = 0
  if (asks) {
    let answer: string
    try {
      answer = await $.ui.ask(askApproval(what, minutes, rules, (notes as string[] | undefined) ?? []), { options: [APPROVE, 'やめる'], header: '入力の占有' })
    } catch {
      answer = ''
    }
    if (answer !== APPROVE) return { deny: declined(answer) }
    approvedAt = await $.clock.now()
  }
  // 待つ間もほかのセッションに始めさせないよう、鍵は待つ前に置き、待つ分だけ長く取る。
  const grace = asks ? GRACE_MS : 0
  if (!Number.isFinite(grace + minutes * 60000 + (await $.clock.now()))) return { deny: 'minutes が大きすぎます。' }
  // 上書きすると、見張りがまだ知らせていない前の鍵の終わりが消えるので、先に知らせる。知らせは鍵を置くのを妨げない。
  await noticeLast($, await lockStatus($), { hasWaited: true }).catch(error => $.ui.log(`input-takeover: 前の鍵の終わりを知らせられなかった: ${String(error)}`, { to: 'debug' }))
  // 答えを待つ間にほかのセッションが鍵を置いていれば、置けずにその鍵が返る。
  const placed = (await locks($, ['acquire', 'input', '--what', what, '--ms', String(grace + minutes * 60000), '--same-root'])) as { ok: boolean; heldBy?: InputLock }
  if (!placed.ok) return { deny: placed.heldBy === undefined ? '鍵を置けなかった。start を呼び直し、続くならユーザーに知らせる。' : await heldByMessage($, placed.heldBy) }
  // 待つ間にユーザーが中断したら、鍵を外して断る。了承した後でも、始める前の中断はやめる合図なので。
  if (grace > 0) {
    const aborted = await $.clock.sleep(grace, { signal }).then(
      () => false,
      () => true,
    )
    if (aborted) {
      await locks($, ['release', 'input', '--same-root'])
      return { deny: '始める前の待ちが中断されたので、鍵を外しました。始めずに、ユーザーの指示を待ってください。' }
    }
    // 了承を記録するのは、待ちを中断されずに始めたときだけ。中断は了承を取り下げる合図なので（中断の後は鍵も無いので、次の start は問う）。10分は答えた時から数える。
    await recordApproval($, session, approvedAt)
  }
  const cautions = rules.agent.length > 0 ? `この環境の注意: ${rules.agent.join(' ')}` : ''
  return {
    result: [
      `鍵を置いた（${minutes}分）。返答の文に「いまからキーボードとマウスを使います。触らないでください」と書いてから操作を始める。終わったら、途中でやめたときも、end で外す。延びるときは start を呼び直す。`,
      cautions,
      problem ?? '',
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

async function end($: EngineInterface) {
  const session = await $.session.id()
  const { released } = (await locks($, ['release', 'input', '--same-root'])) as { released: InputLock | null }
  if (released !== null) {
    const notice = returnedNotice(released.what, await afterReturn($, session))
    if (await claimNotice($, returnedKey(released), session)) {
      // 時間切れ・終わりをまだ知らせていなければ、ほかのセッションが後から出さないよう、知らせたことにする。
      await claimNotice($, expiredKey(released), session)
      await claimNotice($, endedKey(released, released.session), session)
      await announce($, notice)
    }
    return {
      result: `鍵を外し、ユーザーに「${notice}」と知らせた（会話・toast・通知。同じ鍵をもう知らせていれば出さない）。返答の文にも、この知らせのとおりに、キーボードとマウスを返したことと、もう使ってよいか（ほかのセッションが使っていればそのこと）を書く。次の start は、了承のうちでも取り直す。`,
    }
  }
  const held = await effectiveLock($)
  return {
    result:
      held === undefined
        ? '外す鍵は無かった（置いていないか、見込みの時間を過ぎていた）。鍵を置いて操作していたなら、返答の文で、キーボードとマウスをもう使ってよいことを書く。'
        : `外す鍵は無かった。効いているのはほかのセッションの鍵（${await describeLock($, held)}）。`,
  }
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (takesInputInBash(e.command)) {
      const reason = await checkInputTakeover($)
      if (reason !== undefined) return { deny: reason }
    }
    return next(e)
  })

  // PowerShell のツールは Windows でだけ登録されるので、ほかの OS の型には無い。
  on('tool.call', { tool: /^PowerShell$/ }, async ($, e, next) => {
    const { command } = e as { command?: unknown }
    if (typeof command === 'string' && takesInputInPowerShell(command)) {
      const reason = await checkInputTakeover($)
      if (reason !== undefined) return { deny: reason }
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // 読み込み直すと every は止まり、session.start がまた走るので、ここで張り直せば1本のままになる。
    // 人のいないセッション（-p・SDK）は見張らない。知らせを引き受けると、誰にも見えないまま済んだことになるため。
    if (e.isInteractive) {
      $.clock.every(WATCH_MS, () => {
        watch($).catch(error => $.ui.log(`input-takeover: 入力の鍵の見張りが失敗した: ${String(error)}`, { to: 'debug' }))
      })
    }
    await $.tool.register({
      name: 'input_takeover',
      isDeferred: false,
      description:
        'キーボード・マウス・フォーカスを奪う操作（osascript・cliclick・screencapture（窓か範囲を指して撮るだけのものを除く）・xdotool・SendKeys・UI Automation、それらを中で使うスクリプト）の鍵を、同じマシンのセッションどうしで取り合う。input-takeover skill の手順で使う。start は、ユーザーにダイアログで了承を取ってから鍵を置く（了承から10分のうちは、同じフォルダのほかのセッションの鍵の引き継ぎと、notes のある別の what を除いて問わない。鍵が効いていない start（end で返した後・時間切れの後）は、10分のうちでも問う。ほかのセッションの鍵が効いていれば断る）。end は自分の鍵を外す。始めたことと返したことは、セッションが返答の文に書く（mod も、鍵が外れたら会話・toast・通知で知らせる）。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'end'] },
          what: { type: 'string', description: 'start: 何をするか（ほかのセッションに見せる。例: アプリの画面の確かめ）' },
          minutes: { type: 'number', description: 'start: 終わるまでの見込みの分。過ぎると鍵は無いものとみなされる' },
          notes: {
            type: 'array',
            items: { type: 'string' },
            description:
              'start: 了承のダイアログに足す、この作業に限った注意（ユーザーがしてよいこと・いけないこと。1つの要素が1行）。マシンや入力の共有の仕方から決まる注意は mod が設定から出すので、それ以外のときだけ渡す',
          },
        },
        required: ['action'],
      },
    })
    return started
  })

  // 自分で登録したツールは、読み込まれて型が作り直されるまで型に無いので、正規表現で当てる。
  on('tool.call', { tool: new RegExp(`^${TOOL}$`) }, async ($, e, next) => {
    const input = e as { action?: unknown; what?: unknown; minutes?: unknown; notes?: unknown }
    try {
      if (input.action === 'end') return await end($)
      if (input.action === 'start') return await start($, input, next.signal)
      return { deny: 'action は start か end です。' }
    } catch (error) {
      return { deny: `入力の鍵を扱えなかった: ${String(error)}。yorozuya を pull し直すか、machine-locks skill が input-takeover skill の隣にあるかを確かめ、続くならユーザーに知らせる。` }
    }
  })

  // 外したことは、記録を見たほかのセッションの見張り（watch）が知らせる。終わっていくセッションからは通知を出せないため。
  on('session.end', async ($, e, next) => {
    // 見込みの時間を過ぎた鍵も外して記録する。時間切れの知らせ（操作が続いているかもしれない）の後に、終わったことを伝えるため。
    // 鍵を扱えなくても、終わりの処理（next）は続ける（外せなかった鍵は、持ち主が落ちたものとして見張りが見つける）。
    try {
      const { released } = (await locks($, ['release', 'input'], e.sessionId)) as { released: InputLock | null }
      // 切れてから NOTICE_WINDOW_MS を過ぎた鍵は記録しない。とうに使えるようになっていて、知らせると古い話になるため。
      // end で返したと知らせた鍵も記録しない。
      if (released !== null && !released.legacy && (await $.clock.now()) - released.until < NOTICE_WINDOW_MS && !(await hasNoticed($, returnedKey(released)))) {
        await recordEnded($, released)
      }
    } catch (error) {
      $.ui.log(`input-takeover: 終わるときに入力の鍵を外せなかった: ${String(error)}`, { to: 'debug' })
    }
    return next(e)
  })
}
