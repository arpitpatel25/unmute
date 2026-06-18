// Unmute Remote — the floating overlay's renderer (loaded at #/overlay).
//
// A compact, translucent task list shown on top of whatever the user is doing.
// It AUTO-PRESENTS (from the main process) on a terminal/attention state and
// expands the task that just changed; the user reads the result/answer in place,
// answers needs-user by voice (Remote key) or by typing into the task terminal,
// and dismisses with Esc or the ✕ — it NEVER closes on its own.
//
// Reuses the same task event stream (useRemoteTasks) and the full TaskRow for the
// expanded card, so it stays in lockstep with the in-app panel.

import { useEffect, useState } from 'react'
import { useRemoteTasks, type RemoteTask } from './useRemoteTasks'
import { TaskRow } from './TaskRow'

type API = {
  remoteOverlayDismiss?: () => void
  remoteOnOverlayFocus?: (cb: (d: { taskId: string }) => void) => () => void
}
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

const STATE_DOT: Record<RemoteTask['state'], string> = {
  processing: '#3b82f6',
  'needs-user': '#f59e0b',
  stuck: '#f59e0b',
  done: '#22c55e',
  failed: '#ef4444',
}
const STATE_LABEL: Record<RemoteTask['state'], string> = {
  processing: 'working',
  'needs-user': 'needs you',
  stuck: 'stuck',
  done: 'done',
  failed: 'failed',
}

function OverlayRow({
  task, expanded, onToggle, onAnswer, onKill, onRerun,
}: {
  task: RemoteTask
  expanded: boolean
  onToggle: () => void
  onAnswer: (id: string, text: string) => void
  onKill: (id: string) => void
  onRerun: (intent: string) => void
}) {
  if (expanded) {
    return (
      <div>
        <button className="w-full text-left text-[11px] text-white/45 px-1 mb-1 hover:text-white/70" onClick={onToggle}>
          ▾ collapse
        </button>
        {/* The full in-app card (light) sits on the dark overlay — answer/result/terminal all available. */}
        <TaskRow task={task} onAnswer={onAnswer} onKill={onKill} onRerun={onRerun} />
      </div>
    )
  }
  const dot = STATE_DOT[task.state] ?? '#888'
  return (
    <button
      className="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-white/5 text-left"
      onClick={onToggle}
    >
      <span className="inline-block w-[7px] h-[7px] rounded-full shrink-0" style={{ background: dot }} />
      <span className="flex-1 text-[12px] text-white/85 truncate">{task.intent}</span>
      <span className="text-[10px] uppercase tracking-wide shrink-0" style={{ color: dot }}>{STATE_LABEL[task.state]}</span>
    </button>
  )
}

export function OverlayApp() {
  const { tasks, answer, kill, rerun } = useRemoteTasks()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Main tells us which task to expand when it auto-presents.
  useEffect(() => {
    const off = api().remoteOnOverlayFocus?.((d) => setExpandedId(d.taskId))
    return () => off?.()
  }, [])

  // Esc dismisses (only fires when the window is focused — i.e. the user clicked
  // into the overlay; otherwise Esc belongs to dictation/capture). NEVER auto.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); api().remoteOverlayDismiss?.() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const dismiss = () => api().remoteOverlayDismiss?.()

  return (
    <div className="h-screen w-screen p-2" style={{ background: 'transparent' }}>
      <div
        className="h-full flex flex-col rounded-2xl overflow-hidden border border-white/10 shadow-2xl"
        style={{ background: 'rgba(18,18,20,0.84)', backdropFilter: 'blur(14px)' }}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
          <span className="text-[12px] font-semibold text-white/90">Unmute · tasks</span>
          <button className="text-[13px] text-white/50 hover:text-white px-1" onClick={dismiss} title="Dismiss (Esc)">✕</button>
        </div>

        <div className="flex-1 overflow-auto p-2 space-y-1">
          {tasks.length === 0 ? (
            <div className="text-[12px] text-white/40 italic py-8 text-center">No tasks yet.</div>
          ) : (
            tasks.map((t) => (
              <OverlayRow
                key={t.id}
                task={t}
                expanded={expandedId === t.id}
                onToggle={() => setExpandedId(expandedId === t.id ? null : t.id)}
                onAnswer={answer}
                onKill={kill}
                onRerun={rerun}
              />
            ))
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-white/10 text-[10px] text-white/40">
          🎙 hold the Remote key to answer · Esc or ✕ to dismiss
        </div>
      </div>
    </div>
  )
}
