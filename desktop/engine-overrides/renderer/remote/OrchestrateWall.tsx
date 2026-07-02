// Unmute Orchestrate — the cockpit wall (NEW surface, handoff §3 #3).
//
// A voice-conducted cockpit for many concurrent Claude Code sessions. The human
// stays the conductor; this surface owns the ATTENTION layer — always pointing the
// user at the session that most needs them, at near-zero switch cost.
//
// Visual direction: Ops Console (§7). Two hard rules, enforced here:
//   R1 — color encodes EXACTLY ONE variable: status. Cards are structurally
//        identical. The only color anywhere is the status dot + label.
//   R2 — hierarchy from CONTRAST, not whitespace: name brightest → needs-you
//        status loudest → dir/elapsed/meta dimmed toward background.
//
// Interaction (§8): click a card → it MORPHS in place into the big stage (FLIP via
// the View Transitions API) while the others slide+shrink into a right rail. The
// focused stage hoists the pending line VERBATIM (re-entry §6.5) over the REAL
// terminal (LiveTerminal). Crank with `next`/Tab; `full`/F expands the terminal;
// answer by chip, number key (1-9), or (later) voice; esc reverses the motion.
//
// Data is REAL — the existing useRemoteTasks store (one task object, shared with
// the overlay). Dictation core FROZEN; overlay COEXISTS.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRemoteTasks, type RemoteTask } from './useRemoteTasks'
import { LiveTerminal } from './LiveTerminal'

// ─── Ops Console palette — neutral everywhere; hue lives ONLY in `status`. ───
const C = {
  bg: '#0d0f12',
  surface: '#15181d',
  surfaceHi: '#191d23',
  border: '#23272e',
  borderHi: '#323843',
  nameText: '#e8eaed',
  midText: '#9aa0a8',
  dimText: '#5b616b',
  faintText: '#3b4047',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
}

// The ONLY colored variable in the whole surface (R1).
const STATUS = {
  processing: { label: 'working', color: '#3fb950', rank: 99 }, // never queues
  'needs-user': { label: 'needs you', color: '#d29922', rank: 1 },
  stuck: { label: 'stuck', color: '#f85149', rank: 0 },
  failed: { label: 'errored', color: '#f85149', rank: 0 },
  done: { label: 'done', color: '#6e7681', rank: 2 },
} as const

type WallState = RemoteTask['state']
const statusOf = (s: WallState) => STATUS[s] ?? STATUS.processing
const needsYou = (s: WallState) => s === 'needs-user' || s === 'stuck' || s === 'failed'

function elapsed(fromMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - fromMs) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
}

// One-line current activity, and (focused) the line lifted VERBATIM from the
// session — re-entry (§6.5): extraction, NOT an LLM summary.
function activityLine(t: RemoteTask): string {
  return t.question?.text || t.error?.reason || t.step || t.result?.summary || '…'
}

// What the user reads as the session's NAME: the generated short name (2-5 words),
// falling back to a truncated intent until the name lands. Never the full utterance.
function nameOf(t: RemoteTask): string {
  if (t.name) return t.name
  const s = (t.intent || t.id.slice(0, 8)).trim()
  return s.length > 44 ? `${s.slice(0, 44).trimEnd()}…` : s
}

// The session's REAL working directory, compacted (home → ~) — shown only when it
// MEANS something: a project-bound session's repo. A one-off's isolated scratch
// dir (~/.unmute/…/uuid) is machinery, not information — hidden.
function dirLabel(t: RemoteTask): string {
  const cwd = t.cwd || ''
  if (!cwd || cwd.includes('/.unmute/')) return ''
  return cwd.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
}

// FLIP morph: wrap a state change so Chromium captures before/after and tweens
// the matching view-transition-names. No-ops gracefully where unsupported.
function withMorph(fn: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => void }
  if (typeof doc.startViewTransition === 'function') doc.startViewTransition(fn)
  else fn()
}

// Report the focused session to main — focus IS the voice address (§6.2). When set,
// a capture routes here deterministically; null restores pure router behaviour.
function setMainFocus(id: string | null) {
  const api = (window as unknown as { electronAPI?: { remoteSetOrchestrateFocus?: (id: string | null) => Promise<boolean> } }).electronAPI
  void api?.remoteSetOrchestrateFocus?.(id)
}

function Dot({ state }: { state: WallState }) {
  const { color } = statusOf(state)
  return (
    <span style={{
      width: 8, height: 8, borderRadius: 9999, background: color, flex: 'none',
      boxShadow: needsYou(state) ? `0 0 7px ${color}` : 'none', // loud only when it pulls you (R2)
    }} />
  )
}

// ─── full session card (resting grid) — structurally identical for every state ───
function Card({ t, now, queuePos, onClick }: { t: RemoteTask; now: number; queuePos: number | null; onClick: () => void }) {
  const st = statusOf(t.state)
  return (
    <button onClick={onClick}
      style={{
        textAlign: 'left', cursor: 'pointer', fontFamily: C.mono, background: C.surface,
        border: `1px solid ${C.border}`, borderRadius: 8, padding: '11px 13px',
        display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0,
        viewTransitionName: `card-${t.id}`,
      } as React.CSSProperties}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Dot state={t.state} />
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, color: st.color, textTransform: 'uppercase' }}>{st.label}</span>
        {queuePos != null && (
          <span style={{ marginLeft: 'auto', fontSize: 10, color: C.dimText, border: `1px solid ${C.border}`, borderRadius: 4, padding: '1px 5px' }}>Q{queuePos}</span>
        )}
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: C.nameText, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {nameOf(t)}
      </div>
      <div style={{ fontSize: 11.5, color: C.midText, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{activityLine(t)}</div>
      <div style={{ display: 'flex', gap: 10, fontSize: 10.5, color: C.dimText }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {dirLabel(t) || (t.kind === 'session' ? 'session' : 'one-off')}
        </span>
        <span style={{ marginLeft: 'auto', flex: 'none' }}>{elapsed(t.createdAt, now)}</span>
      </div>
    </button>
  )
}

// ─── compact card for the focused right-rail (the others, shrunk) ───
function MiniCard({ t, queuePos, onClick }: { t: RemoteTask; queuePos: number | null; onClick: () => void }) {
  const st = statusOf(t.state)
  return (
    <button onClick={onClick}
      style={{
        textAlign: 'left', cursor: 'pointer', fontFamily: C.mono, background: C.surface,
        border: `1px solid ${C.border}`, borderRadius: 7, padding: '8px 10px',
        display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, width: '100%',
        viewTransitionName: `card-${t.id}`,
      } as React.CSSProperties}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Dot state={t.state} />
        <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.3, color: st.color, textTransform: 'uppercase' }}>{st.label}</span>
        {queuePos != null && <span style={{ marginLeft: 'auto', fontSize: 9, color: C.dimText }}>Q{queuePos}</span>}
      </div>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: C.nameText, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {nameOf(t)}
      </div>
    </button>
  )
}

// Attach an image blob to a session: bytes go to main, which saves them under the
// task's dir and TYPES the path (unsubmitted) into the session — the user's next
// utterance or keystrokes submit it together. The voice-era screenshot paste.
async function attachImageBlob(taskId: string, blob: Blob): Promise<string | null> {
  const api = (window as unknown as { electronAPI?: { remoteAttachImage?: (id: string, data: ArrayBuffer, ext: string) => Promise<string | null> } }).electronAPI
  if (!api?.remoteAttachImage) return null
  const ext = (blob.type.split('/')[1] || 'png').split('+')[0]
  return api.remoteAttachImage(taskId, await blob.arrayBuffer(), ext)
}

// ─── focused stage: hoisted pending line + the REAL terminal ───
function Stage({ t, now, full, onAnswer, onClose, onNext, onToggleFull }: {
  t: RemoteTask; now: number; full: boolean
  onAnswer: (text: string) => void; onClose: () => void; onNext: () => void; onToggleFull: () => void
}) {
  const st = statusOf(t.state)
  const choices = t.question?.choices ?? []

  // Multimodal (images): ⌘V an image or drop a file anywhere on the stage.
  // The toast teaches the contract: attached ≠ sent — speak (or type) to send.
  const [attachNote, setAttachNote] = useState<string | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showNote = useCallback((msg: string) => {
    setAttachNote(msg)
    if (noteTimer.current) clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setAttachNote(null), 4500)
  }, [])
  useEffect(() => () => { if (noteTimer.current) clearTimeout(noteTimer.current) }, [])

  const attach = useCallback(async (blob: Blob) => {
    const path = await attachImageBlob(t.id, blob)
    showNote(path ? 'image attached — speak or type to send it' : 'could not attach — session not running')
  }, [t.id, showNote])

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) { e.preventDefault(); void attach(file) }
      // No image in the clipboard → normal paste (e.g. text into the terminal).
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [attach])
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: C.mono, minWidth: 0, position: 'relative', viewTransitionName: `card-${t.id}` } as React.CSSProperties}
      onDragOver={(e) => { e.preventDefault() }}
      onDrop={(e) => {
        e.preventDefault()
        const img = Array.from(e.dataTransfer?.files ?? []).find((f) => f.type.startsWith('image/'))
        if (img) void attach(img)
      }}
    >
      {/* hoisted header — what this session is, and its controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderBottom: `1px solid ${C.border}`, flex: 'none' }}>
        <Dot state={t.state} />
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, color: st.color, textTransform: 'uppercase' }}>{st.label}</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: C.nameText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(t)}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: C.dimText, flex: 'none' }}>{elapsed(t.createdAt, now)}</span>
        <Key label="next" onClick={onNext} />
        <Key label={full ? 'split' : 'full'} onClick={onToggleFull} />
        <Key label="esc" onClick={onClose} />
      </div>

      {/* pending line, lifted VERBATIM (extraction, not generation §6.5) */}
      {needsYou(t.state) && (
        <div style={{ padding: '13px 14px', background: C.surfaceHi, borderBottom: `1px solid ${C.border}`, flex: 'none' }}>
          <div style={{ fontSize: 14, color: C.nameText, lineHeight: 1.5 }}>{activityLine(t)}</div>
          {choices.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 11 }}>
              {choices.map((c, i) => (
                <button key={c} onClick={() => onAnswer(c)}
                  style={{ fontFamily: C.mono, fontSize: 12, color: C.nameText, background: C.surface, border: `1px solid ${C.borderHi}`, borderRadius: 6, padding: '5px 11px', cursor: 'pointer' }}>
                  <span style={{ color: C.dimText, marginRight: 6 }}>{i + 1}</span>{c}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* the REAL terminal — fills the stage (the wall OWNS the PTY size while
          focused; the overlay defers to a glance — single-owner, no width fight) */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <LiveTerminal taskId={t.id} onClose={onClose} fill />
      </div>

      {/* attach toast — confirms the image landed and teaches "speak to send" */}
      {attachNote && (
        <div style={{ position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)', background: C.surfaceHi, border: `1px solid ${C.borderHi}`, borderRadius: 7, padding: '7px 14px', fontSize: 12, color: C.nameText, pointerEvents: 'none' }}>
          🖼 {attachNote}
        </div>
      )}
    </div>
  )
}

function Key({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      style={{ flex: 'none', background: 'none', border: `1px solid ${C.border}`, color: C.midText, borderRadius: 5, fontSize: 11, padding: '2px 8px', cursor: 'pointer', fontFamily: C.mono }}>
      {label}
    </button>
  )
}

function RailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: C.dimText, textTransform: 'uppercase' }}>{title}</div>
      {children}
    </div>
  )
}

export default function OrchestrateWall() {
  const { tasks, answer } = useRemoteTasks()
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(i)
  }, [])

  // queue: ONLY what needs the user — errored/stuck first, then questions (§4).
  // 'done' is information, not a pull: it shows as a normal card but never queues,
  // never banners "STEP IN" — attention is pulled exclusively by needs-you states.
  const queue = useMemo(
    () => tasks.filter((t) => needsYou(t.state))
      .sort((a, b) => statusOf(a.state).rank - statusOf(b.state).rank || b.updatedAt - a.updatedAt),
    [tasks],
  )
  const queuePos = useMemo(() => {
    const m = new Map<string, number>()
    queue.forEach((t, i) => m.set(t.id, i + 1))
    return m
  }, [queue])

  const focused = focusedId ? tasks.find((t) => t.id === focusedId) ?? null : null
  const top = queue[0] ?? null

  // Species split (§5): the grid is the space of WORKING SESSIONS; one-off
  // errands live (and resolve) in the rail. Until the user has any sessions,
  // the grid shows everything — an empty wall over a busy rail helps no one.
  const sessions = useMemo(() => tasks.filter((t) => t.kind === 'session'), [tasks])
  const oneoffs = useMemo(() => tasks.filter((t) => t.kind !== 'session'), [tasks])
  const gridTasks = sessions.length ? sessions : tasks
  const railOneoffs = sessions.length ? oneoffs : []

  const focus = useCallback((id: string | null) => {
    setMainFocus(id) // tell main where the voice lands BEFORE any utterance (§6.2)
    withMorph(() => { setFocusedId(id); if (id == null) setFull(false) })
  }, [])

  // Clear the focus address when the wall unmounts/closes, so a stale focus can't
  // keep capturing the voice after the user leaves the cockpit.
  useEffect(() => () => setMainFocus(null), [])

  // The crank (§6.4): YOU advance to the next queued item; the system never does.
  const crank = useCallback(() => {
    const q = queue
    if (q.length === 0) return
    const idx = focusedId ? q.findIndex((t) => t.id === focusedId) : -1
    const nextTask = q[(idx + 1) % q.length]
    if (nextTask) focus(nextTask.id)
  }, [queue, focusedId, focus])

  // keyboard: esc reverses (full→split→wall); Tab cranks; F toggles full; 1-9 answer.
  //
  // CRITICAL GUARD: the focused stage's terminal is TYPEABLE — keystrokes there
  // belong to the SESSION, not the wall. Without this, typing an "f" into Claude
  // Code toggles full mode, "1" answers a chip, and Esc — which Claude Code uses
  // to INTERRUPT the agent — would instead unfocus the stage. So: if the event
  // originates inside the terminal (xterm's textarea) or any input, the wall
  // takes nothing; the header buttons (next/full/esc) remain the affordance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.closest?.('.xterm'))) return
      if (e.key === 'Escape') { if (full) setFull(false); else focus(null); return }
      if (!focusedId) return
      if (e.metaKey || e.ctrlKey || e.altKey) return // never swallow app/OS combos (⌘F etc.)
      if (e.key === 'Tab') { e.preventDefault(); crank(); return }
      if (e.key === 'f' || e.key === 'F') { setFull((v) => !v); return }
      if (/^[1-9]$/.test(e.key)) {
        const t = tasksRef.current.find((x) => x.id === focusedId)
        const choice = t?.question?.choices?.[Number(e.key) - 1]
        if (choice) { answer(t!.id, choice); focus(null) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusedId, full, crank, focus, answer])

  const others = focused ? tasks.filter((t) => t.id !== focused.id) : []

  return (
    <div style={{ position: 'absolute', inset: 0, background: C.bg, color: C.midText, fontFamily: C.mono, display: 'flex', flexDirection: 'column' }}>
      {/* tap banner — highest-priority queued item, always at the top (§8) */}
      {top && !full && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface, flex: 'none' }}>
          <Dot state={top.state} />
          <span style={{ fontSize: 12.5, color: C.nameText, fontWeight: 600, flex: 'none' }}>{nameOf(top)}</span>
          <span style={{ fontSize: 12, color: C.midText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>— {activityLine(top)}</span>
          <button onClick={() => focus(top.id)}
            style={{ marginLeft: 'auto', flex: 'none', fontFamily: C.mono, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: C.bg, background: statusOf(top.state).color, border: 'none', borderRadius: 5, padding: '4px 11px', cursor: 'pointer' }}>
            STEP IN ▸
          </button>
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* main: grid (resting) OR the focused stage */}
        <div style={{ flex: 1, minWidth: 0, padding: focused ? 0 : 14, overflow: focused ? 'hidden' : 'auto' }}>
          {focused ? (
            <Stage t={focused} now={now} full={full}
              onAnswer={(text) => { answer(focused.id, text); focus(null) }}
              onClose={() => focus(null)} onNext={crank} onToggleFull={() => setFull((v) => !v)} />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(248px, 1fr))', gap: 11, alignContent: 'start' }}>
              {gridTasks.length === 0 && <div style={{ color: C.dimText, fontSize: 12, padding: 8 }}>no sessions — speak to spawn one</div>}
              {gridTasks.map((t) => <Card key={t.id} t={t} now={now} queuePos={queuePos.get(t.id) ?? null} onClick={() => focus(t.id)} />)}
            </div>
          )}
        </div>

        {/* right rail — Queue/One-offs/Skills when resting; the OTHER sessions when focused (unless full) */}
        {!full && (
          <div style={{ width: focused ? 210 : 230, flex: 'none', borderLeft: `1px solid ${C.border}`, padding: 14, display: 'flex', flexDirection: 'column', gap: 16, overflow: 'auto' }}>
            {focused ? (
              <RailSection title={`Sessions · ${others.length}`}>
                {others.map((t) => <MiniCard key={t.id} t={t} queuePos={queuePos.get(t.id) ?? null} onClick={() => focus(t.id)} />)}
              </RailSection>
            ) : (
              <>
                <RailSection title={`Queue · ${queue.length}`}>
                  {queue.length === 0 && <div style={{ fontSize: 11, color: C.faintText }}>clear</div>}
                  {queue.map((t, i) => (
                    <button key={t.id} onClick={() => focus(t.id)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '3px 0', fontFamily: C.mono }}>
                      <span style={{ fontSize: 10, color: C.dimText, width: 16 }}>Q{i + 1}</span>
                      <Dot state={t.state} />
                      <span style={{ fontSize: 11.5, color: C.midText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(t)}</span>
                    </button>
                  ))}
                </RailSection>
                <RailSection title={`One-offs${railOneoffs.length ? ` · ${railOneoffs.length}` : ''}`}>
                  {railOneoffs.length === 0 && (
                    <div style={{ fontSize: 11, color: C.faintText }}>short-lived tasks resolve here</div>
                  )}
                  {railOneoffs.map((t) => (
                    <button key={t.id} onClick={() => focus(t.id)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '3px 0', fontFamily: C.mono }}>
                      <Dot state={t.state} />
                      <span style={{ fontSize: 11.5, color: C.midText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{nameOf(t)}</span>
                      <span style={{ fontSize: 10, color: C.faintText, flex: 'none' }}>{elapsed(t.createdAt, now)}</span>
                    </button>
                  ))}
                </RailSection>
              </>
            )}
          </div>
        )}
      </div>

      {/* Voice address (§6.2): always shows where the NEXT utterance lands, so the
          user sees it BEFORE speaking. The live hold-to-speak listening surface
          layers on top of this once the capture-state broadcast is wired. */}
      <div style={{ position: 'absolute', left: 14, bottom: 12, display: 'flex', alignItems: 'center', gap: 7, fontFamily: C.mono, fontSize: 11, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 9999, padding: '5px 12px', pointerEvents: 'none' }}>
        <span aria-hidden>🎙</span>
        <span style={{ color: C.dimText }}>voice →</span>
        <span style={{ color: focused ? '#3fb950' : C.midText, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {focused ? nameOf(focused) : 'new task'}
        </span>
      </div>
    </div>
  )
}
