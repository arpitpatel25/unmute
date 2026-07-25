// Unmute Remote — renderer hook: live task list.
//
// Loads the current tasks once, then keeps them in sync via the broadcast
// events from remote/init.ts. Drives both the ambient indicator (count/state)
// and the task panel (full rows). One subscription, shared via this hook.

import { useEffect, useState, useCallback } from 'react'

export interface RemoteTask {
  id: string
  intent: string
  /** Short session name (2-5 words), generated async after dispatch; null until it
   *  lands. UIs show this instead of the full intent, falling back to a truncation. */
  name?: string | null
  /** The session's working directory (its real spawn cwd). */
  cwd?: string
  /** Species: 'session' = persistent working session (never idle-killed/purged);
   *  'oneoff' = fire-and-forget errand (default). */
  kind?: 'oneoff' | 'session'
  /** Which backend runs this task. 'codex-desktop' tasks live in the Codex app:
   *  their work is not a PTY we can show, so the card offers "open in Codex"
   *  instead of the live terminal. */
  agent?: 'claude' | 'codex' | 'codex-desktop'
  /** Codex project the thread was created in (codex-desktop only). */
  codexProject?: string | null
  /** Rolling "where you left off" (2-3 sentences from the session itself,
   *  refreshed every turn) — re-entry warm-up, never authoritative. */
  threadContext?: string | null
  /** Shelved: kept-but-out-of-the-way — hidden from the wall grid, purge-exempt,
   *  findable in the rail's Shelf. */
  shelved?: boolean
  /** The user's card note (ticket link, context) — annotation only. */
  note?: string | null
  /** Provenance: task id that agent-spawned this one via the Unmute MCP. */
  spawnedBy?: string | null
  /** Workspace group ("what is this work about") — assigned once by the router,
   *  mutated only by user curation; null = ungrouped. */
  group?: string | null
  state: 'processing' | 'needs-user' | 'ready' | 'stuck' | 'done' | 'failed'
  category?: 'info' | 'navigate' | 'watch' | 'consume' | 'act' | null
  step?: string | null
  createdAt: number
  updatedAt: number
  result: { summary: string; detail?: string; artifacts?: Array<{ type: 'path' | 'url'; value: string }> } | null
  error: { reason: string; detail?: string } | null
  question: { text: string; kind?: 'free_text' | 'choice' | 'confirm'; choices?: string[]; irreversible?: boolean } | null
  mcpGap: { integration: string; fixCommand: string; message: string } | null
  alive?: boolean
}

// The remote* methods are spread into electronAPI by the build (remote-preload).
// Declared loosely here so the renderer typechecks without the full d.ts.
type RemoteAPIShape = {
  remoteList?: () => Promise<RemoteTask[]>
  remoteAnswer?: (id: string, answer: string) => Promise<boolean>
  remoteKill?: (id: string) => Promise<boolean>
  remoteRemoveTask?: (id: string) => Promise<boolean>
  remoteResume?: (id: string) => Promise<boolean>
  remoteKillAll?: () => Promise<boolean>
  remoteDispatch?: (intent: string) => Promise<string | null>
  // Each returns an unsubscribe fn (older preloads returned void — tolerated).
  remoteOnTaskCreated?: (cb: (t: RemoteTask) => void) => void | (() => void)
  remoteOnTaskUpdated?: (cb: (t: RemoteTask) => void) => void | (() => void)
  remoteOnTaskNeedsUser?: (cb: (t: RemoteTask) => void) => void | (() => void)
  remoteOnTaskDone?: (cb: (t: RemoteTask) => void) => void | (() => void)
  remoteOnTaskFailed?: (cb: (t: RemoteTask) => void) => void | (() => void)
  remoteOnTaskStuck?: (cb: (t: RemoteTask) => void) => void | (() => void)
  remoteOnTaskRemoved?: (cb: (d: { id: string }) => void) => void | (() => void)
}
function api(): RemoteAPIShape {
  return (window as unknown as { electronAPI?: RemoteAPIShape }).electronAPI ?? {}
}

const TERMINAL = new Set(['done', 'failed', 'ready']) // ready = parked, ball with user — not "running" 

export function useRemoteTasks() {
  const [tasks, setTasks] = useState<RemoteTask[]>([])

  const upsert = useCallback((t: RemoteTask) => {
    setTasks((prev) => {
      const next = prev.filter((x) => x.id !== t.id)
      next.unshift(t)
      // newest first; keep it bounded so the panel never grows unbounded
      return next.slice(0, 200)
    })
  }, [])

  // Pull the WHOLE snapshot from the main process. The event stream keeps us live,
  // but events can be missed (a background window that stalls or is re-shown, a
  // dropped IPC) — and with only a one-shot initial load, a single miss leaves the
  // surface permanently drifted (the overlay showing stale tasks). refresh() is the
  // reconcile: callers invoke it on show / periodically so drift can't persist.
  const refresh = useCallback(() => {
    api().remoteList?.().then((list) => { if (Array.isArray(list)) setTasks(list) }).catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    // Every lifecycle channel funnels through upsert — the snapshot is whole.
    // Capture each subscription's unsubscribe fn and tear them ALL down on unmount
    // (the old cleanup left them attached — a listener leak on long-lived windows).
    const offs: Array<void | (() => void)> = [
      api().remoteOnTaskCreated?.(upsert),
      api().remoteOnTaskUpdated?.(upsert),
      api().remoteOnTaskNeedsUser?.(upsert),
      api().remoteOnTaskDone?.(upsert),
      api().remoteOnTaskFailed?.(upsert),
      api().remoteOnTaskStuck?.(upsert),
      api().remoteOnTaskRemoved?.((d) => setTasks((prev) => prev.filter((x) => x.id !== d.id))),
    ]
    return () => { for (const off of offs) if (typeof off === 'function') off() }
  }, [upsert, refresh])

  const activeCount = tasks.filter((t) => !TERMINAL.has(t.state)).length
  const anyNeedsUser = tasks.some((t) => t.state === 'needs-user')

  const answer = useCallback((id: string, text: string) => { void api().remoteAnswer?.(id, text) }, [])
  const kill = useCallback((id: string) => { void api().remoteKill?.(id) }, [])
  const remove = useCallback((id: string) => { void api().remoteRemoveTask?.(id) }, [])
  const killAll = useCallback(() => { void api().remoteKillAll?.() }, [])
  const rerun = useCallback((intent: string) => { void api().remoteDispatch?.(intent) }, [])
  const resume = useCallback((id: string) => { void api().remoteResume?.(id) }, [])

  return { tasks, activeCount, anyNeedsUser, refresh, answer, kill, remove, killAll, rerun, resume }
}
