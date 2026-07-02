// Unmute Remote — renderer hook: live task list.
//
// Loads the current tasks once, then keeps them in sync via the broadcast
// events from remote/init.ts. Drives both the ambient indicator (count/state)
// and the task panel (full rows). One subscription, shared via this hook.

import { useEffect, useState, useCallback } from 'react'

export interface RemoteTask {
  id: string
  intent: string
  state: 'processing' | 'needs-user' | 'stuck' | 'done' | 'failed'
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

const TERMINAL = new Set(['done', 'failed'])

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
