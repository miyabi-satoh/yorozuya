// over: OVER を知らせたか。update: UPDATE を知らせた先の版（まだなら null）。idle: 放置の /clear を送ったか。
export type ContextWatchTold = { over: boolean; update: string | null; idle: boolean }

declare module 'claude-code' {
  interface PluginState {
    'context-watch': { told: ContextWatchTold }
  }
}
