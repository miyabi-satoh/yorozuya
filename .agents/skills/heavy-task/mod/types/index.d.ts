export type HeavyWaitWaiting = { command: string; since: number } | null

declare module 'claude-code' {
  interface PluginState {
    'heavy-wait': { waiting: HeavyWaitWaiting }
  }
}
