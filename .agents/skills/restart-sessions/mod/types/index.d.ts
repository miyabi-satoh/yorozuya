// over: OVER をまだ知らせていなければ false、知らせた後はその時の使用率。update: UPDATE を知らせた先の版（まだなら null）。idle: 放置の /clear を送ったか。
export type ContextWatchTold = { over: boolean | number; update: string | null; idle: boolean }

declare module 'claude-code' {
  interface PluginState {
    'context-watch': { told: ContextWatchTold }
  }
}
