// Unmute Remote — one task row (PRD §13.4). Each row is a "mini-conversation":
// it shows the cleaned intent (the trust-builder), live status, and — when the
// task talks back — an inline result, a failure reason, or a needs-user prompt
// the user answers by tap (voice answering arrives with the realtime layer).
//
// Items covered here (core): #1 intent, #2 status+duration, #3 inline result,
// #4 failure reason, #5 needs-user answer, #6 cancel/kill, #7 re-run.
// (#8 render-on-demand terminal is a follow-on.)

import { useState } from 'react'
import type { RemoteTask } from './useRemoteTasks'

const STATE_LABEL: Record<RemoteTask['state'], string> = {
  processing: 'Working…',
  'needs-user': 'Needs you',
  stuck: 'Possibly stuck',
  done: 'Done',
  failed: 'Failed',
}
const STATE_COLOR: Record<RemoteTask['state'], string> = {
  processing: '#2563eb',
  'needs-user': '#b45309',
  stuck: '#b45309',
  done: '#16a34a',
  failed: '#dc2626',
}

function durationLabel(t: RemoteTask): string {
  const secs = Math.max(0, Math.round((t.updatedAt - t.createdAt) / 1000))
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
}

export function TaskRow({
  task,
  onAnswer,
  onKill,
  onRerun,
}: {
  task: RemoteTask
  onAnswer: (id: string, text: string) => void
  onKill: (id: string) => void
  onRerun: (intent: string) => void
}) {
  const [draft, setDraft] = useState('')
  const active = task.state === 'processing' || task.state === 'needs-user' || task.state === 'stuck'

  return (
    <div className="rounded-lg border border-black/10 p-3 mb-2 bg-white/70">
      {/* #1 cleaned intent — NOT the raw transcript */}
      <div className="text-sm text-ink font-medium leading-snug">{task.intent}</div>

      {/* #2 status + duration */}
      <div className="flex items-center gap-2 mt-1 text-[11px]" style={{ color: STATE_COLOR[task.state] }}>
        <span className="inline-block w-[6px] h-[6px] rounded-full" style={{ background: STATE_COLOR[task.state] }} />
        {STATE_LABEL[task.state]} · {durationLabel(task)}
      </div>

      {/* #3 inline result on done */}
      {task.state === 'done' && task.result && (
        <div className="mt-2 text-[12px] text-ink/80">
          <div>{task.result.summary}</div>
          {task.result.artifacts?.map((a, i) => (
            <button
              key={i}
              className="mt-1 text-[11px] underline text-blue-700 block text-left"
              onClick={() => {
                // Opening artifacts (file/url) is wired to the shell in a follow-on;
                // for now surface the value so the user can act on it.
                void navigator.clipboard?.writeText(a.value)
              }}
              title="Copy"
            >
              {a.type === 'path' ? '📄 ' : '🔗 '}{a.value}
            </button>
          ))}
        </div>
      )}

      {/* #4 failure reason — or, if it's a missing-integration gap, the fix (PRD §12.3) */}
      {task.state === 'failed' && !task.mcpGap && (
        <div className="mt-2 text-[12px] text-red-700">{task.error?.reason ?? 'Failed (no reason reported)'}</div>
      )}
      {task.state === 'failed' && task.mcpGap && (
        <div className="mt-2 text-[12px] text-ink/80">
          <div>{task.mcpGap.message}</div>
          <code
            className="mt-1 inline-block px-1.5 py-0.5 rounded bg-black/5 text-[11px] cursor-pointer"
            title="Copy"
            onClick={() => void navigator.clipboard?.writeText(task.mcpGap!.fixCommand)}
          >
            {task.mcpGap.fixCommand}
          </code>
          <button
            className="ml-2 text-[11px] px-2 py-0.5 rounded border border-black/15 hover:bg-black/5"
            onClick={() => onRerun(task.intent)}
          >
            Retry
          </button>
        </div>
      )}

      {/* #5 needs-user — answer by tap (PRD §7) */}
      {task.state === 'needs-user' && task.question && (
        <div className="mt-2">
          <div className="text-[12px] text-amber-700 mb-1">{task.question.text}</div>
          {task.question.kind === 'choice' && task.question.choices ? (
            <div className="flex flex-wrap gap-1">
              {task.question.choices.map((c) => (
                <button
                  key={c}
                  className="text-[11px] px-2 py-1 rounded border border-amber-300 hover:bg-amber-50"
                  onClick={() => onAnswer(task.id, c)}
                >
                  {c}
                </button>
              ))}
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (draft.trim()) {
                  onAnswer(task.id, draft.trim())
                  setDraft('')
                }
              }}
              className="flex gap-1"
            >
              <input
                className="flex-1 text-[12px] px-2 py-1 rounded border border-amber-300"
                placeholder={task.question.kind === 'confirm' ? 'yes / no' : 'your answer…'}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoFocus
              />
              <button className="text-[11px] px-2 py-1 rounded bg-amber-600 text-white" type="submit">Send</button>
            </form>
          )}
        </div>
      )}

      {/* #6 cancel/kill (running) · #7 re-run (finished) */}
      <div className="flex gap-2 mt-2">
        {active && (
          <button className="text-[11px] px-2 py-0.5 rounded border border-black/15 hover:bg-black/5" onClick={() => onKill(task.id)}>
            Stop
          </button>
        )}
        {!active && (
          <button className="text-[11px] px-2 py-0.5 rounded border border-black/15 hover:bg-black/5" onClick={() => onRerun(task.intent)}>
            Re-run
          </button>
        )}
      </div>
    </div>
  )
}
