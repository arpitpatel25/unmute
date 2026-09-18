import type { RuntimeRpcClient } from './rpc'

/**
 * Is a running daemon safe to replace? Asked with RPCs every older build
 * already answers, because the whole point is to judge a daemon that
 * predates this code. Anything unclear counts as busy: deferring an upgrade
 * costs one more launch on the old build, interrupting a turn loses work.
 */
export type RuntimeService = 'codex' | 'claude' | 'agent'

type CodexTask = { patch?: { state?: string }; gate?: { kind?: string; blocked?: boolean } }

export async function runtimeIdle(rpc: RuntimeRpcClient, services: readonly RuntimeService[]): Promise<boolean> {
  if (services.includes('codex')) {
    const snapshot = await rpc.call<{ tasks?: CodexTask[] }>('codex.snapshot')
    const busy = (snapshot.tasks ?? []).some(t => t.gate?.kind === 'active' || t.gate?.blocked === true
      || t.patch?.state === 'processing' || t.patch?.state === 'needs-user')
    if (busy) return false
  }
  if (services.includes('claude')) {
    const sessions = await rpc.call<Array<{ busy?: boolean }>>('claude.list')
    if (sessions.some(s => s.busy)) return false
  }
  if (services.includes('agent')) {
    // The Agent's own router migrates it off this daemon; while it still lives
    // here at all, leave the upgrade to that router.
    const agent = await rpc.call<{ view?: unknown }>('agent.snapshot')
    if (agent.view) return false
  }
  return true
}
