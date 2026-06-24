// Unmute Remote — the floating overlay's renderer (loaded at #/overlay).
//
// A compact, translucent-DARK task surface shown on top of whatever the user is
// doing. Auto-presents (from the main process) on a terminal/attention state;
// the user reads the result/answer in place, answers needs-user by voice
// (Remote key) or by typing, and dismisses with Esc or the ✕ — it NEVER closes
// on its own.
//
// Layout: tasks are GROUPED by state into three sections — NEEDS YOU (amber),
// RUNNING (blue), RECENT (done/failed list). Needs-you and running cards show
// their content inline (they want attention / are live); recent items are a
// compact list that expands on click for the full result + terminal. This is a
// presentation grouping over the SAME data + actions as before.
//
// Aesthetic: minimal black-glass, no white cards. Its own dark rendering (NOT
// the light in-app TaskRow).

import { useEffect, useState } from 'react'
import { useRemoteTasks, type RemoteTask } from './useRemoteTasks'
import { LiveTerminal } from './LiveTerminal'
import { Markdown } from './Markdown'

type API = {
  remoteOverlayDismiss?: () => void
  remoteOnOverlayFocus?: (cb: (d: { taskId: string }) => void) => () => void
  remoteOpenArtifact?: (type: 'url' | 'path', value: string) => Promise<boolean>
}
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

function duration(t: RemoteTask): string {
  const s = Math.max(0, Math.round((t.updatedAt - t.createdAt) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function openArtifact(type: 'url' | 'path', value: string) {
  const fn = api().remoteOpenArtifact
  if (fn) void fn(type, value)
  else void navigator.clipboard?.writeText(value)
}

function ArtifactLinks({ task }: { task: RemoteTask }) {
  if (!task.result?.artifacts?.length) return null
  return (
    <>
      {task.result.artifacts.map((a, i) => (
        <button
          key={i}
          className="mt-1.5 block text-left text-[11px] text-sky-300/85 hover:text-sky-200 truncate max-w-full"
          onClick={() => openArtifact(a.type, a.value)}
          title={a.type === 'path' ? 'Open in Finder' : 'Open in browser'}
        >
          ↗ {a.value}
        </button>
      ))}
    </>
  )
}

// ─── NEEDS YOU — amber card, question + answer inline ───
function NeedsYouCard({
  task, onAnswer, onKill,
}: {
  task: RemoteTask
  onAnswer: (id: string, text: string) => void
  onKill: (id: string) => void
}) {
  const [draft, setDraft] = useState('')
  const [showTerminal, setShowTerminal] = useState(false)
  const q = task.question
  const isConfirm = q?.kind === 'confirm'
  return (
    <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-[5px] inline-block w-[7px] h-[7px] rounded-full shrink-0" style={{ background: '#fbbf24' }} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-white/90 leading-snug">{task.intent}</div>
          {q?.irreversible && (
            <div className="text-[9px] uppercase tracking-wider text-rose-300/90 mt-0.5">⚠ irreversible</div>
          )}
          {q?.text && <div className="text-[12px] text-amber-200/90 mt-1 leading-relaxed">{q.text}</div>}

          {/* answer affordances */}
          <div className="mt-2">
            {q?.kind === 'choice' && q.choices ? (
              <div className="flex flex-wrap gap-1.5">
                {q.choices.map((c) => (
                  <button key={c} className="text-[11px] px-2 py-1 rounded-lg bg-amber-400/12 text-amber-200/90 hover:bg-amber-400/25"
                    onClick={() => onAnswer(task.id, c)}>{c}</button>
                ))}
                <button className="text-[11px] px-1.5 py-1 text-white/40 hover:text-white/80" onClick={() => setShowTerminal((v) => !v)}>
                  {showTerminal ? 'hide terminal' : 'open terminal'}
                </button>
              </div>
            ) : isConfirm ? (
              <div className="flex items-center gap-3 text-[12px]">
                <button className="text-emerald-300/90 hover:text-emerald-200" onClick={() => onAnswer(task.id, 'yes')}>yes ↗</button>
                <button className="text-white/55 hover:text-white/85" onClick={() => onAnswer(task.id, 'no')}>no</button>
                <button className="text-white/40 hover:text-white/80" onClick={() => setShowTerminal((v) => !v)}>
                  {showTerminal ? 'hide terminal' : 'open terminal'}
                </button>
              </div>
            ) : (
              <form className="flex gap-1.5"
                onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { onAnswer(task.id, draft.trim()); setDraft('') } }}>
                <input
                  className="flex-1 text-[12px] px-2 py-1 rounded-lg bg-white/10 text-white placeholder-white/40 outline-none border border-white/15 focus:border-white/40"
                  style={{ caretColor: '#ffffff' }} placeholder="type your answer…"
                  value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
                <button className="text-[11px] px-2.5 py-1 rounded-lg bg-amber-400/20 text-amber-100" type="submit">send</button>
                <button type="button" className="text-[11px] px-1.5 text-white/40 hover:text-white/80" onClick={() => onKill(task.id)}>stop</button>
              </form>
            )}
          </div>
          <div className="text-[10px] text-white/30 mt-1.5">🎙 or hold the Remote key and speak your answer</div>
          {showTerminal && <LiveTerminal taskId={task.id} onClose={() => setShowTerminal(false)} />}
        </div>
      </div>
    </div>
  )
}

// ─── RUNNING — blue card, spinner + step + timer ───
function RunningCard({ task, onKill }: { task: RemoteTask; onKill: (id: string) => void }) {
  const [showTerminal, setShowTerminal] = useState(false)
  return (
    <div className="rounded-xl border border-sky-400/25 bg-sky-400/[0.05] px-3 py-2.5">
      <div className="flex items-start gap-2">
        <svg className="mt-[3px] shrink-0 animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="#38bdf8" strokeOpacity="0.25" strokeWidth="3" />
          <path d="M21 12a9 9 0 0 0-9-9" stroke="#38bdf8" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <div className="flex-1 text-[13px] font-semibold text-white/90 leading-snug truncate">{task.intent}</div>
            <span className="text-[11px] text-sky-300/80 tabular-nums shrink-0">{duration(task)}</span>
          </div>
          {task.step && <div className="text-[12px] text-white/50 mt-0.5 leading-relaxed">{task.step}</div>}
          <div className="flex items-center gap-3 mt-1.5 text-[11px]">
            <button className="text-white/40 hover:text-white/80" onClick={() => setShowTerminal((v) => !v)}>
              {showTerminal ? 'hide terminal' : 'terminal'}
            </button>
            <button className="text-rose-300/70 hover:text-rose-300" onClick={() => onKill(task.id)}>kill</button>
          </div>
          {showTerminal && <LiveTerminal taskId={task.id} onClose={() => setShowTerminal(false)} />}
        </div>
      </div>
    </div>
  )
}

// ─── RECENT — compact done/failed row, expands for detail + terminal ───
function RecentRow({
  task, expanded, onToggle, onRerun, onRemove, onResume,
}: {
  task: RemoteTask
  expanded: boolean
  onToggle: () => void
  onRerun: (intent: string) => void
  onRemove: (id: string) => void
  onResume: (id: string) => void
}) {
  const [showTerminal, setShowTerminal] = useState(false)
  const failed = task.state === 'failed'
  const title = failed
    ? (task.mcpGap?.message ?? task.error?.reason ?? 'Failed')
    : (task.result?.summary ?? task.intent)
  return (
    <div className="border-t border-white/[0.06] first:border-t-0">
      <button className="w-full flex items-start gap-2.5 py-2 text-left" onClick={onToggle}>
        <span className="mt-[3px] shrink-0 text-[12px] leading-none" style={{ color: failed ? '#fb7185' : '#34d399' }}>
          {failed ? '⚠' : '✓'}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-white/90 leading-snug">{title}</div>
          <div className="text-[11.5px] text-white/45 leading-relaxed truncate">
            {failed
              ? <span className="text-rose-300/70">{task.error?.detail ?? task.intent}</span>
              : <>“{task.intent}” · {duration(task)}</>}
          </div>
        </div>
        {failed && (
          <span className="text-[11px] text-sky-300/85 hover:text-sky-200 shrink-0"
            onClick={(e) => { e.stopPropagation(); onRerun(task.intent) }}>re-run ↗</span>
        )}
      </button>

      <div className="grid transition-[grid-template-rows] duration-200 ease-out" style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}>
        <div className="overflow-hidden">
          {expanded && (
            <div className="pb-2.5 pl-[22px]">
              {task.result?.detail && (
                <div className="max-h-72 overflow-auto text-[12px] text-white/70 border-l border-white/10 pl-2">
                  <Markdown text={task.result.detail} />
                </div>
              )}
              {failed && task.mcpGap && (
                <code className="mt-1 inline-block px-1.5 py-0.5 rounded bg-white/10 text-[11px] text-white/80 cursor-pointer"
                  title="Copy" onClick={() => void navigator.clipboard?.writeText(task.mcpGap!.fixCommand)}>
                  {task.mcpGap.fixCommand}
                </code>
              )}
              <ArtifactLinks task={task} />
              <div className="flex items-center gap-3 mt-2 text-[11px]">
                <button className="text-white/35 hover:text-white/80" onClick={() => onRerun(task.intent)}>re-run</button>
                <button className="text-white/35 hover:text-white/80" title="Continue this exact session with full prior context"
                  onClick={() => onResume(task.id)}>resume</button>
                <button className="text-white/35 hover:text-white/80" onClick={() => setShowTerminal((v) => !v)}>
                  {showTerminal ? 'hide terminal' : 'terminal'}
                </button>
                <button className="text-rose-300/60 hover:text-rose-300 ml-auto" title="Kill the session and erase this task"
                  onClick={() => { if (window.confirm('Kill this task and erase it?')) onRemove(task.id) }}>kill</button>
              </div>
              {showTerminal && <LiveTerminal taskId={task.id} onClose={() => setShowTerminal(false)} />}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SectionLabel({ text, count, color }: { text: string; count?: number; color: string }) {
  return (
    <div className="px-1 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color }}>
      {text}{typeof count === 'number' ? ` · ${count}` : ''}
    </div>
  )
}

export function OverlayApp() {
  const { tasks, activeCount, answer, kill, remove, killAll, rerun, resume } = useRemoteTasks()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    const off = api().remoteOnOverlayFocus?.((d) => setExpandedId(d.taskId))
    return () => off?.()
  }, [])

  // Force the document transparent so only our black-glass card shows.
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

  const needsYou = tasks.filter((t) => t.state === 'needs-user' || t.state === 'stuck')
  const running = tasks.filter((t) => t.state === 'processing')
  const recent = tasks.filter((t) => t.state === 'done' || t.state === 'failed')

  return (
    <div className="h-screen w-screen p-2" style={{ background: 'transparent' }}>
      <div
        className="h-full flex flex-col rounded-[18px] overflow-hidden"
        style={{ background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)' }}
      >
        <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
          <span className="text-[10px] font-semibold tracking-[0.22em] uppercase text-white/35">unmute</span>
          <div className="flex items-center gap-3">
            {activeCount > 0 && (
              <button className="text-[10px] uppercase tracking-wider text-rose-300/55 hover:text-rose-300"
                title="Terminate every running session"
                onClick={() => { if (window.confirm('Kill ALL tasks?')) killAll() }}>kill all</button>
            )}
            <button className="text-[13px] leading-none text-white/25 hover:text-white/70" onClick={dismiss} title="Dismiss (Esc)">✕</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-2">
          {tasks.length === 0 ? (
            <div className="text-[12px] text-white/25 italic py-10 text-center">No tasks yet.</div>
          ) : (
            <>
              {needsYou.length > 0 && (
                <>
                  <SectionLabel text="needs you" count={needsYou.length} color="rgba(251,191,36,0.85)" />
                  <div className="space-y-1.5">
                    {needsYou.map((t) => <NeedsYouCard key={t.id} task={t} onAnswer={answer} onKill={kill} />)}
                  </div>
                </>
              )}
              {running.length > 0 && (
                <>
                  <SectionLabel text="running" count={running.length} color="rgba(56,189,248,0.8)" />
                  <div className="space-y-1.5">
                    {running.map((t) => <RunningCard key={t.id} task={t} onKill={kill} />)}
                  </div>
                </>
              )}
              {recent.length > 0 && (
                <>
                  <SectionLabel text="recent" color="rgba(255,255,255,0.35)" />
                  <div>
                    {recent.map((t) => (
                      <RecentRow
                        key={t.id} task={t}
                        expanded={expandedId === t.id}
                        onToggle={() => setExpandedId(expandedId === t.id ? null : t.id)}
                        onRerun={rerun} onRemove={remove} onResume={resume}
                      />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <div className="px-4 py-2 text-[9.5px] tracking-wide text-white/25">
          hold the Remote key to answer · esc to dismiss
        </div>
      </div>
    </div>
  )
}
