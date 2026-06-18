// Unmute Remote — the floating overlay's renderer (loaded at #/overlay).
//
// A compact, translucent-DARK task surface shown on top of whatever the user is
// doing. Auto-presents (from the main process) on a terminal/attention state and
// expands the task that just changed; the user reads the result/answer in place,
// answers needs-user by voice (Remote key) or by typing into the task terminal,
// and dismisses with Esc or the ✕ — it NEVER closes on its own.
//
// Aesthetic: minimal, black-translucent, no white cards/borders. Its own dark
// rendering (NOT the light in-app TaskRow), with a soft expand/collapse animation.

import { useEffect, useRef, useState } from 'react'
import { useRemoteTasks, type RemoteTask } from './useRemoteTasks'
import { LiveTerminal } from './LiveTerminal'

type API = {
  remoteOverlayDismiss?: () => void
  remoteOnOverlayFocus?: (cb: (d: { taskId: string }) => void) => () => void
  remoteOpenArtifact?: (type: 'url' | 'path', value: string) => Promise<boolean>
}
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

const TAG: Record<RemoteTask['state'], { label: string; text: string; dot: string }> = {
  processing: { label: 'working', text: 'text-sky-300/90', dot: '#38bdf8' },
  'needs-user': { label: 'needs you', text: 'text-amber-300/90', dot: '#fbbf24' },
  stuck: { label: 'stuck', text: 'text-amber-300/90', dot: '#fbbf24' },
  done: { label: 'done', text: 'text-emerald-300/90', dot: '#34d399' },
  failed: { label: 'failed', text: 'text-rose-300/90', dot: '#fb7185' },
}

function duration(t: RemoteTask): string {
  const s = Math.max(0, Math.round((t.updatedAt - t.createdAt) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function Tag({ state }: { state: RemoteTask['state'] }) {
  const tag = TAG[state]
  return (
    <span className={`text-[9px] uppercase tracking-[0.12em] ${tag.text} shrink-0`}>{tag.label}</span>
  )
}

function Dot({ state }: { state: RemoteTask['state'] }) {
  const tag = TAG[state]
  const active = state === 'processing'
  return (
    <span
      className={`inline-block w-[6px] h-[6px] rounded-full shrink-0 ${active ? 'animate-pulse' : ''}`}
      style={{ background: tag.dot }}
    />
  )
}

function Expanded({
  task, onAnswer, onKill, onRerun,
}: {
  task: RemoteTask
  onAnswer: (id: string, text: string) => void
  onKill: (id: string) => void
  onRerun: (intent: string) => void
}) {
  const [draft, setDraft] = useState('')
  const [showTerminal, setShowTerminal] = useState(false)
  const active = task.state === 'processing' || task.state === 'needs-user' || task.state === 'stuck'

  const openArtifact = (type: 'url' | 'path', value: string) => {
    const fn = api().remoteOpenArtifact
    if (fn) void fn(type, value)
    else void navigator.clipboard?.writeText(value)
  }

  return (
    <div className="px-2.5 pb-2.5 pt-1">
      <div className="text-[10px] text-white/30 mb-1.5">{duration(task)}</div>

      {/* done → summary + artifacts */}
      {task.state === 'done' && task.result && (
        <div className="text-[12px] text-white/75 leading-relaxed">
          <div>{task.result.summary}</div>
          {/* Full answer for info/fetch tasks — shown in place so you never need
              the terminal to read the complete result. */}
          {task.result.detail && (
            <div className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap text-white/70 border-l border-white/10 pl-2">
              {task.result.detail}
            </div>
          )}
          {task.result.artifacts?.map((a, i) => (
            <button
              key={i}
              className="mt-1.5 block text-left text-[11px] text-sky-300/85 hover:text-sky-200 truncate max-w-full"
              onClick={() => openArtifact(a.type, a.value)}
              title={a.type === 'path' ? 'Open in Finder' : 'Open in browser'}
            >
              ↗ {a.value}
            </button>
          ))}
        </div>
      )}

      {/* failed → reason / mcp gap */}
      {task.state === 'failed' && !task.mcpGap && (
        <div className="text-[12px] text-rose-300/85">{task.error?.reason ?? 'Failed (no reason reported)'}</div>
      )}
      {task.state === 'failed' && task.mcpGap && (
        <div className="text-[12px] text-white/75">
          <div>{task.mcpGap.message}</div>
          <code
            className="mt-1 inline-block px-1.5 py-0.5 rounded bg-white/10 text-[11px] text-white/80 cursor-pointer"
            title="Copy"
            onClick={() => void navigator.clipboard?.writeText(task.mcpGap!.fixCommand)}
          >
            {task.mcpGap.fixCommand}
          </code>
        </div>
      )}

      {/* needs-user → question + answer (by voice or here) */}
      {task.state === 'needs-user' && task.question && (
        <div>
          {task.question.irreversible && (
            <div className="text-[9px] uppercase tracking-wider text-rose-300/90 mb-1">⚠ irreversible</div>
          )}
          <div className="text-[12px] text-amber-200/90 mb-1.5">{task.question.text}</div>
          {task.question.kind === 'choice' && task.question.choices ? (
            <div className="flex flex-wrap gap-1.5">
              {task.question.choices.map((c) => (
                <button
                  key={c}
                  className="text-[11px] px-2 py-1 rounded-lg bg-amber-400/10 text-amber-200/90 hover:bg-amber-400/20"
                  onClick={() => onAnswer(task.id, c)}
                >
                  {c}
                </button>
              ))}
            </div>
          ) : (
            <form
              className="flex gap-1.5"
              onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { onAnswer(task.id, draft.trim()); setDraft('') } }}
            >
              <input
                className="flex-1 text-[12px] px-2 py-1 rounded-lg bg-white/10 text-white placeholder-white/40 outline-none border border-white/15 focus:border-white/40"
                style={{ caretColor: '#ffffff' }}
                placeholder={task.question.kind === 'confirm' ? 'yes / no' : 'type your answer…'}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoFocus
              />
              <button className="text-[11px] px-2.5 py-1 rounded-lg bg-amber-400/20 text-amber-100" type="submit">send</button>
            </form>
          )}
          <div className="text-[10px] text-white/30 mt-1.5">🎙 or hold the Remote key and speak your answer</div>
        </div>
      )}

      {/* actions */}
      <div className="flex items-center gap-3 mt-2.5 text-[11px]">
        {active && (
          <button className="text-white/35 hover:text-white/80" onClick={() => onKill(task.id)}>stop</button>
        )}
        {!active && (
          <button className="text-white/35 hover:text-white/80" onClick={() => onRerun(task.intent)}>re-run</button>
        )}
        <button className="text-white/35 hover:text-white/80" onClick={() => setShowTerminal((v) => !v)}>
          {showTerminal ? 'hide terminal' : 'terminal'}
        </button>
      </div>

      {showTerminal && <LiveTerminal taskId={task.id} onClose={() => setShowTerminal(false)} />}
    </div>
  )
}

function Row({
  task, expanded, onToggle, onAnswer, onKill, onRerun,
}: {
  task: RemoteTask
  expanded: boolean
  onToggle: () => void
  onAnswer: (id: string, text: string) => void
  onKill: (id: string) => void
  onRerun: (intent: string) => void
}) {
  return (
    <div className={`rounded-xl transition-colors ${expanded ? 'bg-white/[0.05]' : 'hover:bg-white/[0.04]'}`}>
      <button className="w-full flex items-center gap-2.5 px-2.5 py-2 text-left" onClick={onToggle}>
        <Dot state={task.state} />
        <span className="flex-1 text-[12.5px] text-white/85 truncate">{task.intent}</span>
        <Tag state={task.state} />
      </button>
      {/* Soft expand/collapse — grid-rows 0fr→1fr animates height without a fixed px cap. */}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          {expanded && <Expanded task={task} onAnswer={onAnswer} onKill={onKill} onRerun={onRerun} />}
        </div>
      </div>
    </div>
  )
}

export function OverlayApp() {
  const { tasks, answer, kill, rerun } = useRemoteTasks()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    const off = api().remoteOnOverlayFocus?.((d) => setExpandedId(d.taskId))
    return () => off?.()
  }, [])

  // The window body defaults to the app's light background, which (1) shows as a
  // white frame around the card and (2) sits behind the translucent panel, making
  // it look grey instead of black. Force the whole document transparent so only
  // our black-glass card is visible.
  useEffect(() => {
    const prevHtml = document.documentElement.style.background
    const prevBody = document.body.style.background
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    return () => {
      document.documentElement.style.background = prevHtml
      document.body.style.background = prevBody
    }
  }, [])

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
        className="h-full flex flex-col rounded-[18px] overflow-hidden"
        style={{
          // Black glass: actual black at 80% opacity, light blur. No border, no
          // white frame (the document is forced transparent above).
          background: 'rgba(0,0,0,0.8)',
          backdropFilter: 'blur(18px)',
          WebkitBackdropFilter: 'blur(18px)',
        }}
      >
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <span className="text-[10px] font-semibold tracking-[0.22em] uppercase text-white/35">unmute</span>
          <button className="text-[13px] leading-none text-white/25 hover:text-white/70" onClick={dismiss} title="Dismiss (Esc)">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
          {tasks.length === 0 ? (
            <div className="text-[12px] text-white/25 italic py-10 text-center">No tasks yet.</div>
          ) : (
            tasks.map((t) => (
              <Row
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

        <div className="px-4 py-2 text-[9.5px] tracking-wide text-white/25">
          hold the Remote key to answer · esc to dismiss
        </div>
      </div>
    </div>
  )
}
