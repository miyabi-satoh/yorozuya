export type ContextWatchIsWanted = boolean

declare module 'claude-code' {
  interface PluginState {
    'context-watch': { isWanted: ContextWatchIsWanted }
  }
}
