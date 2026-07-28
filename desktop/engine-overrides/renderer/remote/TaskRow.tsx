// Unmute Remote — one task row (PRD §13.4). Each row is a "mini-conversation":
// it shows the cleaned intent (the trust-builder), live status, and — when the
// task talks back — an inline result, a failure reason, or a needs-user prompt
// the user answers by VOICE (hold the Remote key — routed straight to this
// task's answer) or by tap/type.
//
// Items covered here (core): #1 intent, #2 status+duration, #3 inline result,
// #4 failure reason, #5 needs-user answer, #6 cancel/kill, #7 re-run.
// (#8 render-on-demand terminal is a follow-on.)

import { useState } from 'react'
import type { RemoteTask } from './useRemoteTasks'
import { LiveTerminal } from './LiveTerminal'
import { Markdown } from './Markdown'

const STATE_LABEL: Record<RemoteTask['state'], string> = {
  processing: 'Working…',
  'needs-user': 'Needs you',
  ready: 'Ready for you',
  stuck: 'Possibly stuck',
  done: 'Done',
  failed: 'Failed',
}
const STATE_COLOR: Record<RemoteTask['state'], string> = {
  processing: '#2563eb',
  'needs-user': '#b45309',
  ready: '#0e7490',
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
  onRemove,
  onResume,
}: {
  task: RemoteTask
  onAnswer: (id: string, text: string) => void
  onKill: (id: string) => void
  onRerun: (intent: string) => void
  onRemove?: (id: string) => void
  onResume?: (id: string) => void
}) {
  const [draft, setDraft] = useState('')
  const [showTerminal, setShowTerminal] = useState(false)
  const active = task.state === 'processing' || task.state === 'needs-user' || task.state === 'stuck'

  return (
    <div className="rounded-lg border border-black/10 p-3 mb-2 bg-white/70">
      {/* #1 cleaned intent — NOT the raw transcript */}
      <div className="text-sm text-ink font-medium leading-snug">{task.intent}</div>

      {/* #2 status + duration + WHICH BACKEND.
          The wall mixes backends freely, so a card must say where its work
          actually lives — otherwise "open it" is ambiguous and the user can't
          tell why one card has a terminal and another doesn't.
          EVERY backend is named now, not only the non-default one. With several
          providers coming, each in a CLI and a desktop flavour, "untagged means
          Claude" stops being a safe convention — an unlabelled card would just
          mean "some backend we didn't think about". Rendered dim so the common
          case stays quiet. */}
      <div className="flex items-center gap-2 mt-1 text-[11px]" style={{ color: STATE_COLOR[task.state] }}>
        <span className="inline-block w-[6px] h-[6px] rounded-full" style={{ background: STATE_COLOR[task.state] }} />
        {STATE_LABEL[task.state]} · {durationLabel(task)}
        <span
          className="ml-1 text-[10px] text-ink/45"
          title={task.codexProject ? `Runs on ${task.provider?.label ?? 'Codex desktop'} · project ${task.codexProject}` : `Runs on ${task.provider?.label ?? 'Claude Code CLI'}`}
        >
          {task.provider?.label ?? (task.agent === 'codex-desktop' ? 'Codex desktop' : 'Claude Code CLI')}
          {task.codexProject ? ` · ${task.codexProject}` : ''}
        </span>
      </div>

      {/* A resume that did not happen. Shown on the card because the click is
          fire-and-forget: without this the button appeared to do nothing at all
          and the reason lived only in the log. */}
      {task.resumeError && !task.resuming && (
        <div className="mt-1 text-[11px] text-red-700/80" title={task.resumeError}>
          Couldn’t resume — {task.resumeError.startsWith('AGENT_SEPARATION_VIOLATION')
            ? 'this session belongs to a different agent'
            : task.resumeError}
        </div>
      )}

      {/* #3 inline result on done */}
      {task.state === 'done' && task.result && (
        <div className="mt-2 text-[12px] text-ink/80">
          <div>{task.result.summary}</div>
          {task.result.detail && (
            <div className="mt-1.5 max-h-72 overflow-auto text-ink/70 border-l border-black/10 pl-2">
              <Markdown text={task.result.detail} />
            </div>
          )}
          {task.result.artifacts?.map((a, i) => (
            <button
              key={i}
              className="mt-1 text-[11px] underline text-blue-700 block text-left hover:text-blue-900"
              onClick={() => {
                // Open in the user's default app: URL → default browser (background
                // tab, no focus steal), path → Finder. Falls back to copying the
                // value if the bridge isn't present.
                const open = (window as unknown as { electronAPI?: { remoteOpenArtifact?: (t: 'url' | 'path', v: string) => Promise<boolean> } }).electronAPI?.remoteOpenArtifact
                if (open) void open(a.type, a.value)
                else void navigator.clipboard?.writeText(a.value)
              }}
              title={a.type === 'path' ? 'Open in Finder' : 'Open in browser'}
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

      {/* #5 needs-user — answer by voice (hold the Remote key) or by tap (PRD §7) */}
      {task.state === 'needs-user' && task.question && (
        <div className="mt-2 rounded-md border border-amber-300/60 bg-amber-50/60 p-2">
          {task.question.irreversible && (
            <div className="text-[10px] uppercase tracking-wider text-red-700 mb-1">
              ⚠ irreversible — confirm carefully
            </div>
          )}
          <div className="text-[12px] text-amber-800 font-medium mb-0.5">{task.question.text}</div>
          <div className="text-[10px] text-amber-700/70 mb-1.5">
            🎙 Hold the Remote key and speak your answer — or {task.question.kind === 'choice' ? 'tap a choice' : 'type'} below.
          </div>
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
        {/* Resume is a PTY concept. A Codex thread lives in Codex — it has no
            session of ours to end, so it must never be offered one to revive.
            Asked of the provider registry rather than spelled "not Codex", so a
            backend that cannot resume never gets the button by default. */}
        {!active && onResume && (task.provider ? task.provider.canResume : task.agent !== 'codex-desktop') && (
          <button
            className="text-[11px] px-2 py-0.5 rounded border border-black/15 hover:bg-black/5 disabled:opacity-50 disabled:cursor-default"
            title={task.resuming ? 'Bringing the session back…' : 'Continue this exact session with full prior context (resumes interrupted work)'}
            // Disabled WHILE IT WORKS. Resume takes seconds; an enabled button
            // that does nothing visible is what got double-tapped into spawning
            // a second session (the race the manager guards internally).
            disabled={task.resuming}
            onClick={() => onResume(task.id)}
          >
            {task.resuming ? 'Resuming…' : 'Resume'}
          </button>
        )}
        {/* #8 render-on-demand terminal */}
        <button
          className="text-[11px] px-2 py-0.5 rounded border border-black/15 hover:bg-black/5"
          onClick={() => setShowTerminal((v) => !v)}
        >
          {showTerminal ? 'Hide terminal' : 'View terminal'}
        </button>
        {onRemove && (
          <button
            className="text-[11px] px-2 py-0.5 rounded border border-red-200 text-red-700 hover:bg-red-50 ml-auto"
            title="Kill the session and erase this task"
            onClick={() => {
              if (window.confirm('Kill this task and erase it? The Claude session is terminated and the task is removed.')) onRemove(task.id)
            }}
          >
            Kill
          </button>
        )}
      </div>

      {showTerminal && <LiveTerminal taskId={task.id} onClose={() => setShowTerminal(false)} />}
    </div>
  )
}
