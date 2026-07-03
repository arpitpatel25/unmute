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

// ─── Present-tense visibility (the calm-wall rule): pixels are for NOW. ───
// A finished one-off earns wall space only briefly — done fades after 15m,
// errored/stuck after 60m (they were actionable; after an hour the user has
// moved on). Sessions and anything running/needing-you never fade. Nothing is
// ever LOST — every task lives on in the overlay panel + History; the wall just
// stops showing the past. `clearedAt` is the "clear finished" sweep cutoff.
const DONE_FADE_MS = 15 * 60_000
const ATTN_FADE_MS = 60 * 60_000
function visibleOnWall(t: RemoteTask, now: number, clearedAt: number): boolean {
  if (t.kind === 'session') return true
  if (t.state === 'processing' || t.state === 'needs-user') return true
  if (t.updatedAt <= clearedAt) return false // user swept finished ones away
  const age = now - t.updatedAt
  return t.state === 'done' ? age < DONE_FADE_MS : age < ATTN_FADE_MS
}

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
function Card({ t, now, queuePos, promoted = false, onClick }: { t: RemoteTask; now: number; queuePos: number | null; promoted?: boolean; onClick: () => void }) {
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
        {/* graduation narration — the system explains the promotion it just made */}
        {promoted && <span style={{ fontSize: 10, color: C.midText, border: `1px solid ${C.borderHi}`, borderRadius: 4, padding: '1px 6px' }}>↑ now a session</span>}
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
function Stage({ t, now, full, onAnswer, onClose, onNext, onToggleFull, onKill, onResume, onRerun, onRemove }: {
  t: RemoteTask; now: number; full: boolean
  onAnswer: (text: string) => void; onClose: () => void; onNext: () => void; onToggleFull: () => void
  onKill: (id: string) => void; onResume: (id: string) => void; onRerun: (intent: string) => void; onRemove: (id: string) => void
}) {
  const st = statusOf(t.state)
  const choices = t.question?.choices ?? []

  // Inline rename — names are VOICE ADDRESSES; a bad auto-name must be fixable
  // right where you read it. Click the title → edit → Enter/blur saves, Esc drops.
  const [editingName, setEditingName] = useState(false)
  const saveName = useCallback((value: string) => {
    setEditingName(false)
    const v = value.trim()
    if (!v || v === nameOf(t)) return
    const api = (window as unknown as { electronAPI?: { remoteRenameTask?: (id: string, name: string) => Promise<boolean> } }).electronAPI
    void api?.remoteRenameTask?.(t.id, v)
  }, [t])

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
        {editingName ? (
          <input autoFocus defaultValue={nameOf(t)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveName((e.target as HTMLInputElement).value)
              if (e.key === 'Escape') { e.stopPropagation(); setEditingName(false) }
            }}
            onBlur={(e) => saveName(e.target.value)}
            style={{ fontFamily: C.mono, fontSize: 14, fontWeight: 600, color: C.nameText, background: C.surfaceHi, border: `1px solid ${C.borderHi}`, borderRadius: 5, padding: '2px 8px', outline: 'none', minWidth: 220 }} />
        ) : (
          <span onClick={() => setEditingName(true)} title="click to rename (names are voice addresses)"
            style={{ fontSize: 14, fontWeight: 600, color: C.nameText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'text' }}>
            {nameOf(t)}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: C.dimText, flex: 'none' }}>{elapsed(t.createdAt, now)}</span>
        {/* pin (§5): promote an errand to a persistent session (or release one).
            Sessions are exempt from idle-kill + purge — they live until you end them. */}
        <Key label={t.kind === 'session' ? 'unpin' : 'pin'} onClick={() => {
          const api = (window as unknown as { electronAPI?: { remoteSetKind?: (id: string, kind: 'oneoff' | 'session') => Promise<boolean> } }).electronAPI
          void api?.remoteSetKind?.(t.id, t.kind === 'session' ? 'oneoff' : 'session')
        }} />
        {/* lifecycle controls — the manual fallback is always present (§9) */}
        {t.alive ? (
          <Key label="kill" danger onClick={() => { if (window.confirm('Stop this session?')) onKill(t.id) }} />
        ) : (
          <Key label="resume" onClick={() => onResume(t.id)} />
        )}
        <Key label="remove" danger onClick={() => { if (window.confirm('Remove this task entirely? Its session and scratch files are erased.')) { onRemove(t.id); onClose() } }} />
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

      {/* ALIVE → the REAL terminal, painted FRESH (no stale-width replay — the
          live TUI repaints on SIGWINCH; replaying old-width frames is what
          garbled the stage). DEAD → never an empty black void: the result/error
          panel with resume / re-run as the obvious next move. */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {t.alive ? (
          <LiveTerminal taskId={t.id} onClose={onClose} fill replay={false} />
        ) : (
          <div style={{ height: '100%', overflow: 'auto', padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: C.dimText, textTransform: 'uppercase' }}>
              session ended · {st.label}
            </div>
            {t.result?.summary && <div style={{ fontSize: 14, color: C.nameText, lineHeight: 1.55 }}>{t.result.summary}</div>}
            {t.result?.detail && <div style={{ fontSize: 12.5, color: C.midText, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{t.result.detail}</div>}
            {t.error?.reason && <div style={{ fontSize: 13, color: C.midText, lineHeight: 1.5 }}>{t.error.reason}{t.error.detail ? ` — ${t.error.detail}` : ''}</div>}
            {!t.result?.summary && !t.error?.reason && <div style={{ fontSize: 12.5, color: C.dimText }}>No recorded output.</div>}
            <div style={{ display: 'flex', gap: 9, marginTop: 4 }}>
              <button onClick={() => onResume(t.id)}
                style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 700, color: C.bg, background: '#3fb950', border: 'none', borderRadius: 6, padding: '7px 16px', cursor: 'pointer' }}>
                resume — continue with full context
              </button>
              <button onClick={() => onRerun(t.intent)}
                style={{ fontFamily: C.mono, fontSize: 12, color: C.nameText, background: C.surface, border: `1px solid ${C.borderHi}`, borderRadius: 6, padding: '7px 16px', cursor: 'pointer' }}>
                re-run fresh
              </button>
            </div>
          </div>
        )}
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

function Key({ label, onClick, danger = false }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick}
      style={{ flex: 'none', background: 'none', border: `1px solid ${danger ? '#5b2a2e' : C.border}`, color: danger ? '#c56069' : C.midText, borderRadius: 5, fontSize: 11, padding: '2px 8px', cursor: 'pointer', fontFamily: C.mono }}>
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

type CapturePhase = 'listening' | 'transcribing' | 'routing' | 'idle'

export default function OrchestrateWall() {
  const { tasks, answer, kill, remove, resume, rerun } = useRemoteTasks()
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  // The listening surface: live voice lifecycle (listening → transcribing →
  // routing → idle+landed). Observed from main's additive broadcast — the wall
  // never drives the capture. `landedId` flashes target confirmation (§9):
  // "your words went THERE."
  const [capturePhase, setCapturePhase] = useState<CapturePhase>('idle')
  const [landedId, setLandedId] = useState<string | null>(null)
  const landedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { remoteOnCapturePhase?: (cb: (d: { phase: CapturePhase; taskId: string | null }) => void) => () => void } }).electronAPI
    const off = api?.remoteOnCapturePhase?.((d) => {
      setCapturePhase(d.phase)
      if (d.phase === 'idle' && d.taskId) {
        setLandedId(d.taskId)
        if (landedTimer.current) clearTimeout(landedTimer.current)
        landedTimer.current = setTimeout(() => setLandedId(null), 3500)
      }
    })
    return () => { off?.(); if (landedTimer.current) clearTimeout(landedTimer.current) }
  }, [])

  // Declinable route offer (§6.2): "started new — or send to X?". One tap
  // redirects (mis-spawn erased, utterance rerouted); ignoring costs nothing —
  // it expires after 8s. NEVER a silent reroute, never a blocking prompt.
  const [offer, setOffer] = useState<{ newTaskId: string; altTaskId: string; altName: string } | null>(null)
  const offerTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { remoteOnRouteOffer?: (cb: (d: { newTaskId: string; altTaskId: string; altName: string }) => void) => () => void } }).electronAPI
    const off = api?.remoteOnRouteOffer?.((d) => {
      setOffer(d)
      if (offerTimer.current) clearTimeout(offerTimer.current)
      offerTimer.current = setTimeout(() => setOffer(null), 8000)
    })
    return () => { off?.(); if (offerTimer.current) clearTimeout(offerTimer.current) }
  }, [])
  const acceptOffer = useCallback(() => {
    const o = offer
    setOffer(null)
    if (!o) return
    const api = (window as unknown as { electronAPI?: { remoteAcceptRouteOffer?: (id: string) => Promise<boolean> } }).electronAPI
    void api?.remoteAcceptRouteOffer?.(o.newTaskId).then((ok) => { if (ok) focusRef.current?.(o.altTaskId) })
  }, [offer])

  // Glance vocabulary (rails): skills + projects from disk, so the words you can
  // SAY are always in front of you. Loaded on mount, refreshed every 5 min.
  const [skills, setSkills] = useState<Array<{ name: string; lastUsed: string }>>([])
  const [projects, setProjects] = useState<Array<{ name: string; path: string }>>([])
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { remoteListSkills?: () => Promise<Array<{ name: string; lastUsed: string }>>; remoteListProjects?: () => Promise<Array<{ name: string; path: string }>> } }).electronAPI
    const load = () => {
      void api?.remoteListSkills?.().then((s) => setSkills(s ?? [])).catch(() => {})
      void api?.remoteListProjects?.().then((p) => setProjects(p ?? [])).catch(() => {})
    }
    load()
    const i = setInterval(load, 5 * 60_000)
    return () => clearInterval(i)
  }, [])
  const spawnInProject = useCallback((p: { name: string; path: string }) => {
    // A click must never silently spawn a whole session (learned the hard way —
    // one grazed row created a task the user never asked for). Confirm first.
    if (!window.confirm(`Start a working session in ${p.name}?\n${p.path}`)) return
    const api = (window as unknown as { electronAPI?: { remoteDispatch?: (intent: string) => Promise<string | null> } }).electronAPI
    void api?.remoteDispatch?.(`Start a working session in the ${p.name} project (${p.path}).`)
  }, [])

  // Staging tray (capture first, speak second): images pasted/dropped with NO
  // focused stage stage in main and ride with the NEXT utterance to wherever it
  // lands. The natural order — grab screenshots, then say what they mean.
  const [stagedCount, setStagedCount] = useState(0)
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { remoteGetStaged?: () => Promise<number>; remoteOnStagedChanged?: (cb: (d: { count: number }) => void) => () => void } }).electronAPI
    void api?.remoteGetStaged?.().then((n) => setStagedCount(n ?? 0))
    const off = api?.remoteOnStagedChanged?.((d) => setStagedCount(d.count))
    return () => off?.()
  }, [])
  const stageBlob = useCallback(async (blob: Blob) => {
    const api = (window as unknown as { electronAPI?: { remoteStageImage?: (data: ArrayBuffer, ext: string) => Promise<string | null> } }).electronAPI
    if (!api?.remoteStageImage) return
    const ext = (blob.type.split('/')[1] || 'png').split('+')[0]
    await api.remoteStageImage(await blob.arrayBuffer(), ext)
  }, [])
  // Paste with nothing focused → tray (the Stage's own paste handler covers the
  // focused case; this one stands down whenever a stage is open).
  const focusedIdRef = useRef(focusedId)
  focusedIdRef.current = focusedId
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (focusedIdRef.current) return // Stage handles direct attach
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) { e.preventDefault(); void stageBlob(file) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [stageBlob])
  const clearStaged = useCallback(() => {
    const api = (window as unknown as { electronAPI?: { remoteClearStaged?: () => Promise<boolean> } }).electronAPI
    void api?.remoteClearStaged?.()
  }, [])

  // Voice-as-doorbell toggle (§6.4): spoken headlines for needs-you states —
  // one toggle away, and the cockpit is fully usable dead silent.
  const [doorbell, setDoorbell] = useState(true)
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { remoteGetVoiceHeadlines?: () => Promise<boolean> } }).electronAPI
    void api?.remoteGetVoiceHeadlines?.().then((v) => setDoorbell(v !== false))
  }, [])
  const toggleDoorbell = useCallback(() => {
    setDoorbell((v) => {
      const api = (window as unknown as { electronAPI?: { remoteSetVoiceHeadlines?: (on: boolean) => Promise<boolean> } }).electronAPI
      void api?.remoteSetVoiceHeadlines?.(!v)
      return !v
    })
  }, [])
  // focus() is declared below; a ref bridges the declaration order without
  // widening the dependency graph of this callback.
  const focusRef = useRef<((id: string | null) => void) | null>(null)

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(i)
  }, [])

  // "Clear finished" sweep cutoff — hides terminal one-offs immediately.
  const [clearedAt, setClearedAt] = useState(0)
  const visible = useMemo(() => tasks.filter((t) => visibleOnWall(t, now, clearedAt)), [tasks, now, clearedAt])

  // While-you-were-away digest (§4 re-entry): after a real absence, one quiet
  // line instead of a wall of stale cards. Dismisses on click or first focus.
  const [digest, setDigest] = useState<string | null>(null)
  useEffect(() => {
    const KEY = 'orchestrate-last-seen'
    const last = Number(localStorage.getItem(KEY) || 0)
    const away = Date.now() - last
    if (last && away > 30 * 60_000 && tasks.length) {
      const needs = tasks.filter((t) => needsYou(t.state) && t.updatedAt > last).length
      const finished = tasks.filter((t) => t.state === 'done' && t.updatedAt > last).length
      if (needs || finished) {
        const parts = []
        if (needs) parts.push(`${needs} need${needs === 1 ? 's' : ''} you`)
        if (finished) parts.push(`${finished} errand${finished === 1 ? '' : 's'} finished`)
        setDigest(`while you were away: ${parts.join(' · ')}`)
      }
    }
    const mark = () => localStorage.setItem(KEY, String(Date.now()))
    mark()
    const i = setInterval(mark, 60_000) // keep fresh while the wall is open
    return () => { clearInterval(i); mark() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Graduation narration: when a one-off promotes itself to a session, SAY SO —
  // a card silently teleporting between lists reads as a glitch, not a feature.
  const prevKinds = useRef(new Map<string, string>())
  const [promotedAt, setPromotedAt] = useState(new Map<string, number>())
  useEffect(() => {
    for (const t of tasks) {
      const prev = prevKinds.current.get(t.id)
      if (prev === 'oneoff' && t.kind === 'session') {
        setPromotedAt((m) => new Map(m).set(t.id, Date.now()))
      }
      prevKinds.current.set(t.id, t.kind ?? 'oneoff')
    }
  }, [tasks])

  // queue: ONLY what needs the user — errored/stuck first, then questions (§4).
  // 'done' is information, not a pull: it shows as a normal card but never queues,
  // never banners "STEP IN" — attention is pulled exclusively by needs-you states.
  // Faded tasks don't queue either: a 12h-old failed errand must not hold Q1.
  const queue = useMemo(
    () => visible.filter((t) => needsYou(t.state))
      .sort((a, b) => statusOf(a.state).rank - statusOf(b.state).rank || b.updatedAt - a.updatedAt),
    [visible],
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
  // All present-tense (visibleOnWall): the past lives in History, not here.
  const sessions = useMemo(() => visible.filter((t) => t.kind === 'session'), [visible])
  const oneoffs = useMemo(() => visible.filter((t) => t.kind !== 'session'), [visible])
  const gridTasks = sessions.length ? sessions : visible
  const railOneoffs = sessions.length ? oneoffs : []
  const hiddenFinished = tasks.length - visible.length

  const focus = useCallback((id: string | null) => {
    setMainFocus(id) // tell main where the voice lands BEFORE any utterance (§6.2)
    withMorph(() => { setFocusedId(id); if (id == null) setFull(false) })
  }, [])
  focusRef.current = focus

  // Clear the focus address when the wall unmounts/closes, so a stale focus can't
  // keep capturing the voice after the user leaves the cockpit.
  useEffect(() => () => setMainFocus(null), [])

  // Focus hygiene (the "Happy Rates!" lesson): the focused stage is the voice
  // address ONLY while the cockpit window itself has the user's attention. The
  // moment they switch to another app, the address is released (utterances route
  // normally); returning to the cockpit re-asserts it. The visual stage never
  // moves — only where the voice lands. Predictable: what you see is the address.
  const [winFocused, setWinFocused] = useState(() => document.hasFocus())
  useEffect(() => {
    const onBlur = () => { setWinFocused(false); setMainFocus(null) }
    const onFocus = () => { setWinFocused(true); setMainFocus(focusedId) }
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    return () => { window.removeEventListener('blur', onBlur); window.removeEventListener('focus', onFocus) }
  }, [focusedId])
  // What the voice chip must show: the ADDRESS, which is the focused task only
  // while the window has attention. The chip may never lie (§6.2).
  const voiceTarget = winFocused ? focused : null

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
        if (choice) {
          answer(t!.id, choice)
          // throughput loop: straight to the next task needing you (wall if clear)
          const next = tasksRef.current.find((x) => x.id !== focusedId && needsYou(x.state))
          focus(next ? next.id : null)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusedId, full, crank, focus, answer])

  // Focused rail = switch targets: sessions + LIVE one-offs only (present tense —
  // no more "SESSIONS · 21" listing every dead errand of the day).
  const others = focused ? visible.filter((t) => t.id !== focused.id) : []

  return (
    <div
      style={{ position: 'absolute', inset: 0, background: C.bg, color: C.midText, fontFamily: C.mono, display: 'flex', flexDirection: 'column', padding: '14px 16px 16px' }}
      onDragOver={(e) => { if (!focused) e.preventDefault() }}
      onDrop={(e) => {
        if (focused) return // the Stage's own drop handler owns the focused case
        e.preventDefault()
        for (const f of Array.from(e.dataTransfer?.files ?? [])) {
          if (f.type.startsWith('image/')) void stageBlob(f)
        }
      }}
    >
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
              onAnswer={(text) => {
                answer(focused.id, text)
                // The throughput loop (§3): acting on a task IS the crank — go
                // straight to the next thing that needs you; wall when clear.
                const next = queue.find((q) => q.id !== focused.id)
                focus(next ? next.id : null)
              }}
              onClose={() => focus(null)} onNext={crank} onToggleFull={() => setFull((v) => !v)}
              onKill={kill} onResume={resume} onRerun={rerun} onRemove={remove} />
          ) : (
            <>
              {digest && (
                <button onClick={() => setDigest(null)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', fontFamily: C.mono, fontSize: 12, color: C.midText, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7, padding: '8px 13px', marginBottom: 11, cursor: 'pointer' }}>
                  {digest} <span style={{ color: C.faintText }}>· dismiss</span>
                </button>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(248px, 1fr))', gap: 11, alignContent: 'start' }}>
                {gridTasks.length === 0 && <div style={{ color: C.dimText, fontSize: 12, padding: 8 }}>no sessions — speak to spawn one</div>}
                {gridTasks.map((t) => <Card key={t.id} t={t} now={now} queuePos={queuePos.get(t.id) ?? null} promoted={(promotedAt.get(t.id) ?? 0) > now - 8000} onClick={() => focus(t.id)} />)}
              </div>
            </>
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
                  {railOneoffs.some((t) => t.state === 'done' || (needsYou(t.state) && t.state !== 'needs-user')) && (
                    <button onClick={() => setClearedAt(Date.now())}
                      style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, fontFamily: C.mono, fontSize: 10.5, color: C.faintText, cursor: 'pointer', textDecoration: 'underline' }}>
                      clear finished
                    </button>
                  )}
                  {railOneoffs.length === 0 && (
                    <div style={{ fontSize: 11, color: C.faintText }}>
                      {hiddenFinished > 0 ? `${hiddenFinished} finished earlier — see History` : 'short-lived tasks resolve here'}
                    </div>
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
                {projects.length > 0 && (
                  <RailSection title="Projects">
                    {projects.map((p) => (
                      <button key={p.path} onClick={() => spawnInProject(p)} title={`Start a session in ${p.path}`}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '3px 0', fontFamily: C.mono }}>
                        <span style={{ fontSize: 11, color: C.faintText }}>▸</span>
                        <span style={{ fontSize: 11.5, color: C.midText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                      </button>
                    ))}
                  </RailSection>
                )}
                {skills.length > 0 && (
                  <RailSection title="Skills">
                    {/* glance vocabulary — say a skill's name to use it */}
                    {skills.map((s) => (
                      <div key={s.name} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0' }}>
                        <span style={{ fontSize: 11.5, color: C.midText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{s.name}</span>
                        <span style={{ fontSize: 10, color: C.faintText, flex: 'none' }}>{s.lastUsed ? s.lastUsed.slice(5, 10) : ''}</span>
                      </div>
                    ))}
                  </RailSection>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* staging tray chip — the images waiting for your next utterance */}
      {stagedCount > 0 && (
        <div style={{ position: 'absolute', left: 14, bottom: 46, display: 'flex', alignItems: 'center', gap: 8, fontFamily: C.mono, fontSize: 11, background: C.surfaceHi, border: `1px solid ${C.borderHi}`, borderRadius: 9999, padding: '5px 12px' }}>
          <span aria-hidden>🖼</span>
          <span style={{ color: C.nameText }}>{stagedCount} staged</span>
          <span style={{ color: C.dimText }}>— speaks with your next task</span>
          <button onClick={clearStaged} title="Drop the staged images"
            style={{ background: 'none', border: 'none', color: C.dimText, cursor: 'pointer', fontFamily: C.mono, fontSize: 12, padding: 0 }}>✕</button>
        </div>
      )}

      {/* doorbell toggle — bottom-right, out of the way, always reachable */}
      <button onClick={toggleDoorbell}
        title={doorbell ? 'Spoken headlines ON (task needs you → one spoken line). Click to silence.' : 'Spoken headlines OFF — fully silent. Click to enable.'}
        style={{ position: 'absolute', right: 14, bottom: offer ? 52 : 12, fontFamily: C.mono, fontSize: 13, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 9999, padding: '4px 10px', cursor: 'pointer', color: doorbell ? C.midText : C.faintText }}>
        {doorbell ? '🔔' : '🔕'}
      </button>

      {/* Declinable route offer: one tap redirects, ignoring costs nothing. */}
      {offer && (
        <button onClick={acceptOffer}
          style={{ position: 'absolute', right: 14, bottom: 12, display: 'flex', alignItems: 'center', gap: 7, fontFamily: C.mono, fontSize: 11.5, background: C.surfaceHi, border: `1px solid ${C.borderHi}`, borderRadius: 9999, padding: '6px 13px', cursor: 'pointer', color: C.nameText }}>
          <span style={{ color: C.dimText }}>started new —</span>
          <span>send to “{offer.altName.length > 34 ? `${offer.altName.slice(0, 34)}…` : offer.altName}” instead?</span>
        </button>
      )}

      {/* The listening surface (§6.2/§9): live voice lifecycle. Idle → where the
          NEXT utterance lands (visible BEFORE speaking). Listening → pulsing mic.
          Transcribing/routing → in flight. Landed → target confirmation flash. */}
      <style>{`@keyframes wall-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.25 } }`}</style>
      <div style={{
        position: 'absolute', left: 14, bottom: 12, display: 'flex', alignItems: 'center', gap: 7,
        fontFamily: C.mono, fontSize: 11, background: C.surface, borderRadius: 9999, padding: '5px 12px', pointerEvents: 'none',
        border: `1px solid ${capturePhase === 'listening' ? '#3fb950' : C.border}`,
        transition: 'border-color 150ms',
      }}>
        {capturePhase === 'listening' ? (
          <>
            <span style={{ width: 8, height: 8, borderRadius: 9999, background: '#3fb950', animation: 'wall-pulse 1.1s ease-in-out infinite' }} />
            <span style={{ color: C.nameText }}>listening →</span>
            <span style={{ color: '#3fb950', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {voiceTarget ? nameOf(voiceTarget) : 'new task'}
            </span>
          </>
        ) : capturePhase === 'transcribing' || capturePhase === 'routing' ? (
          <>
            <span style={{ width: 8, height: 8, borderRadius: 9999, background: '#d29922', animation: 'wall-pulse 0.7s ease-in-out infinite' }} />
            <span style={{ color: C.midText }}>{capturePhase === 'routing' ? 'routing…' : 'transcribing…'}</span>
          </>
        ) : landedId ? (
          <>
            <span aria-hidden>🎙</span>
            <span style={{ color: C.dimText }}>landed →</span>
            <span style={{ color: '#3fb950', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {(() => { const lt = tasks.find((x) => x.id === landedId); return lt ? nameOf(lt) : 'new task' })()}
            </span>
          </>
        ) : (
          <>
            <span aria-hidden>🎙</span>
            <span style={{ color: C.dimText }}>voice →</span>
            <span style={{ color: voiceTarget ? '#3fb950' : C.midText, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {voiceTarget ? nameOf(voiceTarget) : 'new task'}
            </span>
          </>
        )}
      </div>
    </div>
  )
}
