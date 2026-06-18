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
  remoteDispatch?: (intent: string) => Promise<string | null>
  remoteOnTaskCreated?: (cb: (t: RemoteTask) => void) => void
  remoteOnTaskUpdated?: (cb: (t: RemoteTask) => void) => void
  remoteOnTaskNeedsUser?: (cb: (t: RemoteTask) => void) => void
  remoteOnTaskDone?: (cb: (t: RemoteTask) => void) => void
  remoteOnTaskFailed?: (cb: (t: RemoteTask) => void) => void
  remoteOnTaskStuck?: (cb: (t: RemoteTask) => void) => void
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

  useEffect(() => {
    let alive = true
    api().remoteList?.().then((list) => { if (alive && Array.isArray(list)) setTasks(list) }).catch(() => {})
    // Every lifecycle channel funnels through upsert — the snapshot is whole.
    api().remoteOnTaskCreated?.(upsert)
    api().remoteOnTaskUpdated?.(upsert)
    api().remoteOnTaskNeedsUser?.(upsert)
    api().remoteOnTaskDone?.(upsert)
    api().remoteOnTaskFailed?.(upsert)
    api().remoteOnTaskStuck?.(upsert)
    return () => { alive = false }
  }, [upsert])

  const activeCount = tasks.filter((t) => !TERMINAL.has(t.state)).length
  const anyNeedsUser = tasks.some((t) => t.state === 'needs-user')

  const answer = useCallback((id: string, text: string) => { void api().remoteAnswer?.(id, text) }, [])
  const kill = useCallback((id: string) => { void api().remoteKill?.(id) }, [])
  const rerun = useCallback((intent: string) => { void api().remoteDispatch?.(intent) }, [])

  return { tasks, activeCount, anyNeedsUser, answer, kill, rerun }
}
