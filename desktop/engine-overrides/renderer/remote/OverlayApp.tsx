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
import { Markdown } from './Markdown'

type OverlayModeInfo = { mode: 'hidden' | 'docked' | 'expanded'; docked: boolean }
type API = {
  remoteOverlayDismiss?: () => void
  remoteOverlayExpand?: () => void
  remoteOverlaySetInteractive?: (on: boolean) => void
  remoteOverlayGetMode?: () => Promise<OverlayModeInfo>
  remoteOnOverlayMode?: (cb: (d: OverlayModeInfo) => void) => () => void
  remoteOnOverlayFocus?: (cb: (d: { taskId: string }) => void) => () => void
  remoteOpenArtifact?: (type: 'url' | 'path', value: string) => Promise<boolean>
  remoteOnOrchestrateOwner?: (cb: (d: { taskId: string | null }) => void) => () => void
  remoteGetOrchestrateOwner?: () => Promise<string | null>
  remoteAttachImage?: (taskId: string, data: ArrayBuffer, ext: string) => Promise<string | null>
  remoteOnRouteOffer?: (cb: (d: { newTaskId: string; altTaskId: string; altName: string }) => void) => () => void
  remoteAcceptRouteOffer?: (newTaskId: string) => Promise<boolean>
}
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

// Content-level entrance animations (the window snaps instantly; this is what
// gives the dock↔panel transition its smoothness). Origin is bottom-right so
// the panel grows out of / shrinks toward the dock corner.
const POP_CSS = `
@keyframes unmuteOverlayPop { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }
@keyframes unmuteDockPop { from { opacity: 0; transform: translateY(8px) scale(0.9); } to { opacity: 1; transform: translateY(0) scale(1); } }
`

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
  task, onAnswer, onKill, onRerun, onRemove, onResume,
}: {
  task: RemoteTask
  onAnswer: (id: string, text: string) => void
  onKill: (id: string) => void
  onRerun: (intent: string) => void
  onRemove: (id: string) => void
  onResume: (id: string) => void
}) {
  const [draft, setDraft] = useState('')
  const [showTerminal, setShowTerminal] = useState(false)
  const active = task.state === 'processing' || task.state === 'needs-user' || task.state === 'stuck'

  // Single-owner terminal: when the wall is focused on THIS session it owns the PTY
  // size, so the overlay must NOT also render a terminal (two LiveTerminals would
  // fight over the width). Collapse to a glance whenever the wall owns us.
  const [wallOwned, setWallOwned] = useState(false)
  useEffect(() => {
    let alive = true
    void api().remoteGetOrchestrateOwner?.().then((id) => { if (alive) setWallOwned(id === task.id) })
    const off = api().remoteOnOrchestrateOwner?.((d) => setWallOwned(d.taskId === task.id))
    return () => { alive = false; off?.() }
  }, [task.id])
  useEffect(() => { if (wallOwned) setShowTerminal(false) }, [wallOwned])

  const openArtifact = (type: 'url' | 'path', value: string) => {
    const fn = api().remoteOpenArtifact
    if (fn) void fn(type, value)
    else void navigator.clipboard?.writeText(value)
  }

  // Multimodal: drop a screenshot on the expanded card (or ⌘V while it's open) —
  // saved under the task's dir, path typed UNSUBMITTED into the session; the next
  // utterance/keystrokes send it. Mirrors the wall stage's contract.
  const [attachNote, setAttachNote] = useState<string | null>(null)
  const attach = async (blob: Blob) => {
    const fn = api().remoteAttachImage
    if (!fn) return
    const ext = (blob.type.split('/')[1] || 'png').split('+')[0]
    const path = await fn(task.id, await blob.arrayBuffer(), ext)
    setAttachNote(path ? 'image attached — speak to send' : 'could not attach — session not running')
    setTimeout(() => setAttachNote(null), 4000)
  }
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) { e.preventDefault(); void attach(file) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id])

  return (
    <div
      className="px-2.5 pb-2.5 pt-1"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const img = Array.from(e.dataTransfer?.files ?? []).find((f) => f.type.startsWith('image/'))
        if (img) void attach(img)
      }}
    >
      <div className="text-[10px] text-white/30 mb-1.5">{duration(task)}</div>
      {attachNote && <div className="text-[11px] text-white/60 mb-1.5">🖼 {attachNote}</div>}

      {/* done → summary + artifacts */}
      {task.state === 'done' && task.result && (
        <div className="text-[12px] text-white/75 leading-relaxed">
          <div>{task.result.summary}</div>
          {/* Full answer for info/fetch tasks — shown in place so you never need
              the terminal to read the complete result. */}
          {task.result.detail && (
            <div className="mt-1.5 max-h-72 overflow-auto text-white/70 border-l border-white/10 pl-2">
              <Markdown text={task.result.detail} />
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
        {!active && (
          <button
            className="text-white/35 hover:text-white/80"
            title="Continue this exact session with full prior context"
            onClick={() => onResume(task.id)}
          >resume</button>
        )}
        {wallOwned ? (
          <span className="text-white/30" title="This session's terminal is open in the Orchestrate cockpit">in cockpit ↗</span>
        ) : (
          <button className="text-white/35 hover:text-white/80" onClick={() => setShowTerminal((v) => !v)}>
            {showTerminal ? 'hide terminal' : 'terminal'}
          </button>
        )}
        <button
          className="text-rose-300/60 hover:text-rose-300 ml-auto"
          title="Kill the session and erase this task"
          onClick={() => { if (window.confirm('Kill this task and erase it?')) onRemove(task.id) }}
        >
          kill
        </button>
      </div>

      {showTerminal && !wallOwned && <LiveTerminal taskId={task.id} onClose={() => setShowTerminal(false)} />}
    </div>
  )
}

function Row({
  task, expanded, onToggle, onAnswer, onKill, onRerun, onRemove, onResume,
}: {
  task: RemoteTask
  expanded: boolean
  onToggle: () => void
  onAnswer: (id: string, text: string) => void
  onKill: (id: string) => void
  onRerun: (intent: string) => void
  onRemove: (id: string) => void
  onResume: (id: string) => void
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
          {expanded && <Expanded task={task} onAnswer={onAnswer} onKill={onKill} onRerun={onRerun} onRemove={onRemove} onResume={onResume} />}
        </div>
      </div>
    </div>
  )
}

/** The docked pill — compact bottom-right summary of live work. Click anywhere
 *  to expand into the full panel; ✕ closes it for the session. */
function DockPill({
  running, attention, onExpand, onDismiss,
}: {
  running: number
  attention: number
  onExpand: () => void
  onDismiss: () => void
}) {
  // NOTE: the transparent document background is set once by OverlayApp's stable
  // top-level effect (it runs regardless of mode), so we deliberately do NOT set
  // it here — a per-mode effect that restores on unmount raced on every dock↔panel
  // switch and caused flashes.

  // The dock window is click-through by default so it never blocks the apps
  // behind it; flip it interactive only while the cursor is over the pill.
  const enter = () => api().remoteOverlaySetInteractive?.(true)
  const leave = () => api().remoteOverlaySetInteractive?.(false)

  return (
    <div className="h-screen w-screen p-2 flex items-end justify-end" style={{ background: 'transparent' }}>
      <style>{POP_CSS}</style>
      <button
        className="group flex items-center gap-2 rounded-full pl-3.5 pr-2 py-2 cursor-pointer transition-colors hover:bg-black/90"
        onMouseEnter={enter}
        onMouseLeave={leave}
        style={{
          background: 'rgba(0,0,0,0.8)',
          backdropFilter: 'blur(18px)',
          WebkitBackdropFilter: 'blur(18px)',
          // Hairline border + soft shadow (same recipe as the recording pill) so
          // it has a defined edge on dark surfaces (terminals) where a shadow
          // alone is invisible — and the shadow covers light backgrounds.
          border: '1px solid rgba(255, 255, 255, 0.55)',
          boxShadow: '0 12px 36px rgba(0, 0, 0, 0.55), 0 1px 0 rgba(255,255,255,0.04) inset',
          transformOrigin: 'bottom right',
          animation: 'unmuteDockPop 300ms cubic-bezier(0.16,1,0.3,1)',
        }}
        onClick={onExpand}
        title="Click to expand"
      >
        <span className="inline-block w-[7px] h-[7px] rounded-full animate-pulse shrink-0" style={{ background: '#38bdf8' }} />
        <span className="text-[11.5px] text-white/85 whitespace-nowrap">
          {running} running
          {attention > 0 && <span className="text-amber-300/90"> · {attention} stuck</span>}
        </span>
        <span
          className="ml-1 text-[12px] leading-none text-white/25 hover:text-white/80 px-1"
          onClick={(e) => { e.stopPropagation(); onDismiss() }}
          title="Close"
          role="button"
          aria-label="Close"
        >✕</span>
      </button>
    </div>
  )
}

export function OverlayApp() {
  const { tasks, activeCount, answer, kill, remove, killAll, rerun, resume } = useRemoteTasks()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // 'docked' → compact pill; 'expanded' → full panel. dockedEnabled mirrors the
  // setting so Esc can be labelled "collapse" (docked) vs "dismiss" (legacy).
  const [mode, setMode] = useState<'docked' | 'expanded'>('expanded')
  const [dockedEnabled, setDockedEnabled] = useState(true)

  // Declinable route offer (ambient surface — the wall may not be open):
  // "started new — send to X instead?". One tap redirects; expires in 8s.
  const [offer, setOffer] = useState<{ newTaskId: string; altTaskId: string; altName: string } | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = api().remoteOnRouteOffer?.((d) => {
      setOffer(d)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setOffer(null), 8000)
    })
    return () => { off?.(); if (timer) clearTimeout(timer) }
  }, [])

  useEffect(() => {
    const off = api().remoteOnOverlayFocus?.((d) => setExpandedId(d.taskId))
    // Fetch the current presentation on mount (avoids a mode-event race), then
    // stay in sync. 'hidden' draws as the full panel — we only render while the
    // window is visible; the main process owns show/hide.
    void api().remoteOverlayGetMode?.().then((m) => {
      if (m) { setMode(m.mode === 'docked' ? 'docked' : 'expanded'); setDockedEnabled(m.docked) }
    })
    const offMode = api().remoteOnOverlayMode?.((m) => {
      setMode(m.mode === 'docked' ? 'docked' : 'expanded')
      setDockedEnabled(m.docked)
    })
    return () => { off?.(); offMode?.() }
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

  // Esc is owned by the MAIN process (a global shortcut) so it works even when
  // the overlay is unfocused, and routes to collapse-vs-dismiss based on the
  // docked setting — so there's intentionally no Esc keydown handler here.

  const dismiss = () => api().remoteOverlayDismiss?.()

  const running = tasks.filter((t) => t.state === 'processing').length
  const attention = tasks.filter((t) => t.state === 'needs-user' || t.state === 'stuck').length

  // Docked: a compact pill (counts only). Click to expand; ✕ to close.
  if (mode === 'docked') {
    return (
      <DockPill
        running={running}
        attention={attention}
        onExpand={() => api().remoteOverlayExpand?.()}
        onDismiss={dismiss}
      />
    )
  }

  return (
    <div className="h-screen w-screen p-2" style={{ background: 'transparent' }}>
      <style>{POP_CSS}</style>
      <div
        className="h-full flex flex-col rounded-[18px] overflow-hidden"
        style={{
          // Black glass: actual black at 80% opacity, light blur. No border, no
          // white frame (the document is forced transparent above).
          background: 'rgba(0,0,0,0.8)',
          backdropFilter: 'blur(18px)',
          WebkitBackdropFilter: 'blur(18px)',
          transformOrigin: 'bottom right',
          animation: 'unmuteOverlayPop 300ms cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <span className="text-[10px] font-semibold tracking-[0.22em] uppercase text-white/35">unmute</span>
          <div className="flex items-center gap-3">
            {activeCount > 0 && (
              <button
                className="text-[10px] uppercase tracking-wider text-rose-300/55 hover:text-rose-300"
                title="Terminate every running session"
                onClick={() => { if (window.confirm('Kill ALL tasks?')) killAll() }}
              >
                kill all
              </button>
            )}
            <button className="text-[13px] leading-none text-white/25 hover:text-white/70" onClick={dismiss} title="Dismiss (Esc)">✕</button>
          </div>
        </div>

        {/* Declinable route offer strip — one tap redirects, ignoring costs nothing. */}
        {offer && (
          <button
            className="mx-2 mb-1 rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-left text-[11.5px] text-white/85 hover:bg-white/[0.12]"
            onClick={() => {
              const o = offer
              setOffer(null)
              void api().remoteAcceptRouteOffer?.(o.newTaskId).then((ok) => { if (ok) setExpandedId(o.altTaskId) })
            }}
          >
            <span className="text-white/45">started new — </span>
            send to “{offer.altName.length > 38 ? `${offer.altName.slice(0, 38)}…` : offer.altName}” instead?
          </button>
        )}

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
                onRemove={remove}
                onResume={resume}
              />
            ))
          )}
        </div>

        <div className="px-4 py-2 text-[9.5px] tracking-wide text-white/25">
          hold the Remote key to answer · {dockedEnabled ? 'esc to collapse' : 'esc to dismiss'}
        </div>
      </div>
    </div>
  )
}
