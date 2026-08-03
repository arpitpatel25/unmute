// Unmute Orchestrator — the wall (NEW surface, handoff §3 #3).
//
// A voice-conducted Orchestrator for many concurrent agent sessions. The human
// stays the conductor; this surface owns the ATTENTION layer — always pointing the
// user at the session that most needs them, at near-zero switch cost.
//
// NAMING (launch spec pack-c §2): the surface is the ORCHESTRATOR. The word
// "cockpit" is deleted from the product — header, title, comments, log lines.
// `#/orchestrate` survives only as a route hash, which no user reads.
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
import { groupSections } from './groupSections'
import { LiveTerminal } from './LiveTerminal'
import {
  agentAndModel, canKill, canResume, dirLabel, hasTerminal, openInLabel,
  providerLabel, vendorMark,
} from './taskFacts'

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

// Vendor marks, capability questions and the ticket's facts live in
// `taskFacts.ts`: the wall and the main window's Tasks page must answer "which
// agent, which model, which directory" and "may this be resumed" identically,
// and two copies of that is exactly what the provider registry replaced.

// The ONLY colored variable in the whole surface (R1).
const STATUS = {
  processing: { label: 'working', color: '#3fb950', rank: 99 }, // never queues
  'needs-user': { label: 'needs you', color: '#d29922', rank: 1 },
  ready: { label: 'ready', color: '#39c5cf', rank: 2 }, // ball with YOU — calm pull, never a bell
  stuck: { label: 'stuck', color: '#f85149', rank: 0 },
  failed: { label: 'errored', color: '#f85149', rank: 0 },
  done: { label: 'done', color: '#6e7681', rank: 99 }, // information, never a pull
} as const

type WallState = RemoteTask['state']
const statusOf = (s: WallState) => STATUS[s] ?? STATUS.processing
const needsYou = (s: WallState) => s === 'needs-user' || s === 'stuck' || s === 'failed'
/** "Your move" — everything the queue/crank walks: loud states + calm ready. */
const yourMove = (s: WallState) => needsYou(s) || s === 'ready'

// ─── Present-tense visibility (the calm-wall rule): pixels are for NOW. ───
//
// THE 24-HOUR WINDOW (spec §3.2). This function used to return `true` for every
// `kind === 'session'`, forever — which is why a session last touched 46 days
// ago still held a card that said "ready", and why twelve identical "Ready"
// cards could fill the wall with nothing ranked. The rule is now one sentence
// for every kind: **live now, or updated within 24 hours.**
//
// It also replaced two invisible timers (done faded at 15m, errored/stuck at
// 60m). Those were a second, unlabelled time filter with no control attached —
// exactly the silent truncation §3.2 forbids. One window, one control, one
// honest count of what it hides.
//
// Nothing is ever LOST: every task lives on in the overlay panel and History,
// `All` in the header restores it here, and `clearedAt` is still the "clear
// finished" sweep cutoff.
const WALL_WINDOW_MS = 24 * 60 * 60_000

/** Grid density (spec §3.3): cards a group shows before `+N more`. One full row
 *  at the widest layout the window reaches. Not a time bound — see the header's
 *  `Last 24h` for that; these are two different controls with two different words. */
const GRID_ROW = 8

/** Live NOW: actually running, or actually holding a question open. `ready`
 *  deliberately does NOT count — a parked "ready" card is a finished thing
 *  waiting to be read, and treating it as live is what kept the 46-day-old one
 *  on screen. `alive` covers a long-running session that is genuinely still up
 *  even though nobody has touched it today. */
function liveNow(t: RemoteTask): boolean {
  return t.state === 'processing' || t.state === 'needs-user' || t.alive === true
}

/** @param allTime — the header's `Last 24h ▾ / All` filter, off by default. */
function visibleOnWall(t: RemoteTask, now: number, clearedAt: number, allTime: boolean): boolean {
  if (t.shelved) return false // shelved = kept, deliberately out of sight (rail Shelf)
  if (liveNow(t)) return true
  if (t.updatedAt <= clearedAt) return false // user swept finished ones away
  if (allTime) return true
  return now - t.updatedAt < WALL_WINDOW_MS
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

// FLIP morph: wrap a state change so Chromium captures before/after and tweens
// the matching view-transition-names. No-ops gracefully where unsupported.
function withMorph(fn: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => void }
  if (typeof doc.startViewTransition === 'function') doc.startViewTransition(fn)
  else fn()
}

// DEV-ONLY full-UX logging: emit a structured curator event for every user-facing
// action. UNCONDITIONAL — main holds the single gate (devLogEnabled) and drops it
// when off, so a packaged build logs nothing while this keeps calling. Payloads
// stay small + structured (no giant blobs; the engine side dumps heavy data).
function curatorDevLog(payload: Record<string, unknown>) {
  const api = (window as unknown as { electronAPI?: { curatorDevLog?: (p: Record<string, unknown>) => void } }).electronAPI
  api?.curatorDevLog?.(payload)
}

// Report the focused session to main — focus IS the voice address (§6.2). When set,
// a capture routes here deterministically; null restores pure router behaviour.
function setMainFocus(id: string | null) {
  const api = (window as unknown as { electronAPI?: { remoteSetOrchestrateFocus?: (id: string | null) => Promise<boolean> } }).electronAPI
  void api?.remoteSetOrchestrateFocus?.(id)
}

/** Hand the user the real chat thread (main routes open-in-terminal by backend). */
function openInApp(id: string) {
  const api = (window as unknown as { electronAPI?: { remoteOpenInTerminal?: (id: string) => Promise<boolean> } }).electronAPI
  void api?.remoteOpenInTerminal?.(id)
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
function Card({ t, now, queuePos, promoted = false, attention = false, onClick }: { t: RemoteTask; now: number; queuePos: number | null; promoted?: boolean; attention?: boolean; onClick: () => void }) {
  const st = statusOf(t.state)
  return (
    <button onClick={onClick} className="ow-card"
      style={{
        textAlign: 'left', cursor: 'pointer', fontFamily: C.mono, background: attention ? C.surfaceHi : C.surface,
        // Needs-you band (spec §3.1): amber edge + glow, so the band reads as
        // one loud object rather than as ordinary cards under a heading.
        border: `1px solid ${attention ? STATUS['needs-user'].color : C.border}`,
        boxShadow: attention ? `0 0 0 1px rgba(210,153,34,0.18), 0 0 18px rgba(210,153,34,0.13)` : 'none',
        borderRadius: 8, padding: '11px 13px',
        display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0,
        viewTransitionName: `card-${t.id}`,
      } as React.CSSProperties}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Dot state={t.state} />
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, color: st.color, textTransform: 'uppercase' }}>{st.label}</span>
        {/* graduation narration — the system explains the promotion it just made */}
        {promoted && <span style={{ fontSize: 10, color: C.midText, border: `1px solid ${C.borderHi}`, borderRadius: 4, padding: '1px 6px' }}>↑ now a session</span>}
        {/* provenance — agent-created tasks are always visibly labeled */}
        {t.spawnedBy && <span title={`Created by another task (${t.spawnedBy.slice(0, 8)}) via the Unmute MCP`} style={{ fontSize: 10, color: '#d2a8ff', border: '1px solid rgba(210,168,255,0.35)', borderRadius: 4, padding: '1px 6px' }}>↳ agent</span>}
        {queuePos != null && (
          <span style={{ marginLeft: 'auto', fontSize: 10, color: C.dimText, border: `1px solid ${C.border}`, borderRadius: 4, padding: '1px 5px' }}>Q{queuePos}</span>
        )}
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: C.nameText, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {nameOf(t)}
      </div>
      <div style={{ fontSize: 11.5, color: C.midText, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{activityLine(t)}</div>
      {t.note && (
        <div style={{ fontSize: 10.5, color: C.dimText, fontStyle: 'italic', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>✎ {t.note}</div>
      )}
      {/* FOOTER (spec §4.1): agent · model, the working directory, the age —
          dim ink throughout, never competing with the title. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10.5, color: C.dimText }}>
        {/* vendor mark — scannable without reading */}
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: 2, flex: 'none', background: vendorMark(t) }} />
        {/* The backend, present for every card. `model` is a HISTORICAL FACT
            sent by main (D6): when it is absent the agent stands alone — no
            default, no settings read, no placeholder word. */}
        <span style={{ flex: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '55%' }}
          title={t.model ? `Ran on ${providerLabel(t)} · ${t.model}` : `Ran on ${providerLabel(t)}`}>
          {providerLabel(t)}{t.model ? ` · ${t.model}` : ''}
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}
          title={t.cwd || undefined}>
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
    <button onClick={onClick} className="ow-card"
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

/**
 * The four facts every ticket owes the user (spec §4.2):
 * Agent · Model · Working directory · Permissions.
 *
 * Three of them are properties of THIS task, sent by main and never re-derived
 * here. `model` is a historical fact (D6) and is simply absent when main could
 * not determine one — the row then says so rather than borrowing the picker's
 * current value, which would look exactly as correct as a true one.
 *
 * Permissions is the honest exception, and is labelled as one. It is not
 * recorded per task anywhere: `permissionMode` is a single live setting read by
 * the executor factory at spawn time (init.ts:951), so the only truthful thing
 * this surface can show is the setting as it stands now. It says "current
 * setting" out loud rather than implying the task ran under it.
 */
function TicketFacts({ t }: { t: RemoteTask }) {
  const [permission, setPermission] = useState<string | null>(null)
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { remoteGetSettings?: () => Promise<{ permissionMode?: string }> } }).electronAPI
    void api?.remoteGetSettings?.().then((s) => {
      if (s?.permissionMode) setPermission(s.permissionMode === 'auto-approve' ? 'auto-approve' : 'ask before acting')
    }).catch(() => {})
  }, [])
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 26px', padding: '9px 14px', borderBottom: `1px solid ${C.border}`, flex: 'none' }}>
      <Fact label="agent" value={<><span aria-hidden style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 2, background: vendorMark(t), marginRight: 6 }} />{providerLabel(t)}</>} />
      <Fact label="model" value={t.model ?? <span style={{ color: C.faintText }}>not recorded</span>} />
      <Fact label="working directory" value={dirLabel(t) || <span style={{ color: C.faintText }}>none</span>} title={t.cwd || undefined} />
      <Fact label="permissions" value={permission ? `${permission}` : '…'} title="The current Orchestrator setting — permission mode is not recorded per task." />
    </div>
  )
}

function Fact({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }} title={title}>
      <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1, color: C.dimText, textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontSize: 12, color: C.midText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  )
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

  // Inline note edit — same pattern as rename (Enter/blur saves, Esc drops);
  // unlike rename, EMPTY is meaningful (clears the note).
  const [editingNote, setEditingNote] = useState(false)
  const saveNote = useCallback((value: string) => {
    setEditingNote(false)
    const v = value.trim()
    if (v === (t.note ?? '')) return
    const api = (window as unknown as { electronAPI?: { remoteSetNote?: (id: string, note: string) => Promise<boolean> } }).electronAPI
    void api?.remoteSetNote?.(t.id, v)
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
    // No re-anchor needed: xterm renders the raw PTY stream directly, so Claude's
    // own redraw of its input box arrives in-band and lands correctly on its own.
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
        {/* Lifecycle controls ASK THE REGISTRY (spec §4.3), never the id.
            A driver-backed thread has no PTY, so `alive` is always false for
            one — this branch used to read that as "dead" and offer to RESUME a
            chat that had never stopped. Resume renders only where
            `provider.canResume`; a backend that cannot resume gets the door into
            its own app instead, not a greyed-out button. */}
        {!hasTerminal(t) && <Key label={openInLabel(t)} onClick={() => openInApp(t.id)} />}
        {canKill(t) && t.alive && (
          <Key label="kill" danger onClick={() => { if (window.confirm('Stop this session?')) onKill(t.id) }} />
        )}
        {canResume(t) && !t.alive && (
          <Key label="resume" onClick={() => onResume(t.id)} />
        )}
        {/* shelve (parked states only): keep it, stop seeing it. Unshelve is
            always offered on a shelved task so the shelf is never one-way. */}
        {(t.shelved || t.state === 'done' || t.state === 'ready' || t.state === 'failed') && (
          <Key label={t.shelved ? 'unshelve' : 'shelve'} onClick={() => {
            const api = (window as unknown as { electronAPI?: { remoteSetShelved?: (id: string, on: boolean) => Promise<boolean> } }).electronAPI
            void api?.remoteSetShelved?.(t.id, !t.shelved)
            if (!t.shelved) onClose() // shelving = "out of my sight" — leave the stage too
          }} />
        )}
        <Key label="remove" danger onClick={() => { if (window.confirm('Remove this task entirely? Its session and scratch files are erased.')) { onRemove(t.id); onClose() } }} />
        <Key label="next" onClick={onNext} />
        <Key label={full ? 'split' : 'full'} onClick={onToggleFull} />
        <Key label="esc" onClick={onClose} />
      </div>

      {/* THE FOUR FIELDS (spec §4.2). Always rendered, always in this order, so
          "what is this and where did it run" never needs hunting for. */}
      <TicketFacts t={t} />

      {/* warm-up: "where you left off" — the session's own rolling context,
          shown on re-entry so the human never cold-starts. Framed as re-entry
          aid, not truth; hidden while the task needs you (the question wins). */}
      {!needsYou(t.state) && t.threadContext && (
        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, flex: 'none' }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: C.dimText, textTransform: 'uppercase', marginRight: 9 }}>where you left off</span>
          <span style={{ fontSize: 12.5, color: C.midText, lineHeight: 1.5 }}>{t.threadContext}</span>
        </div>
      )}

      {/* note — the user's own annotation (ticket link, context for future-you).
          Click to edit in place; empty clears. Never sent to the agent. */}
      <div style={{ padding: '7px 14px', borderBottom: `1px solid ${C.border}`, flex: 'none', display: 'flex', alignItems: 'baseline', gap: 9 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: C.dimText, textTransform: 'uppercase', flex: 'none' }}>note</span>
        {editingNote ? (
          <input autoFocus defaultValue={t.note ?? ''}
            placeholder="ticket link, context, a reminder for future-you…"
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveNote((e.target as HTMLInputElement).value)
              if (e.key === 'Escape') { e.stopPropagation(); setEditingNote(false) }
            }}
            onBlur={(e) => saveNote(e.target.value)}
            style={{ fontFamily: C.mono, fontSize: 12, color: C.midText, background: C.surfaceHi, border: `1px solid ${C.borderHi}`, borderRadius: 5, padding: '2px 8px', outline: 'none', flex: 1 }} />
        ) : (
          <span onClick={() => setEditingNote(true)} title="click to edit"
            style={{ fontSize: 12, color: t.note ? C.midText : C.faintText, fontStyle: t.note ? 'normal' : 'italic', cursor: 'text', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {t.note || 'add a note…'}
          </span>
        )}
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

      {/* CHAT BACKEND → where a Claude task shows its terminal, a Codex task
          shows where its conversation lives. Neither the terminal nor the ended-
          session panel belongs here: the first does not exist for this backend,
          the second offered to resume a chat that never stopped.
          ALIVE → the REAL terminal, painted FRESH (no stale-width replay — the
          live TUI repaints on SIGWINCH; replaying old-width frames is what
          garbled the stage). DEAD → never an empty black void: the result/error
          panel with resume / re-run as the obvious next move. */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {!hasTerminal(t) ? (
          <div style={{ height: '100%', overflow: 'auto', padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: C.dimText, textTransform: 'uppercase' }}>
              {providerLabel(t)} thread · {st.label}
            </div>
            {t.threadContext && <div style={{ fontSize: 13, color: C.midText, lineHeight: 1.55 }}>{t.threadContext}</div>}
            {t.result?.summary && <div style={{ fontSize: 14, color: C.nameText, lineHeight: 1.55 }}>{t.result.summary}</div>}
            {t.result?.detail && <div style={{ fontSize: 12.5, color: C.midText, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{t.result.detail}</div>}
            <div style={{ display: 'flex', gap: 9, marginTop: 4 }}>
              <button onClick={() => openInApp(t.id)}
                style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 700, color: C.bg, background: vendorMark(t), border: 'none', borderRadius: 6, padding: '7px 16px', cursor: 'pointer' }}>
                {openInLabel(t)} — the thread is still there
              </button>
            </div>
          </div>
        ) : t.alive ? (
          <LiveTerminal taskId={t.id} onClose={onClose} fill />
        ) : (
          <div style={{ height: '100%', overflow: 'auto', padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: C.dimText, textTransform: 'uppercase' }}>
              session ended · {st.label}
            </div>
            {t.result?.summary && <div style={{ fontSize: 14, color: C.nameText, lineHeight: 1.55 }}>{t.result.summary}</div>}
            {t.result?.detail && <div style={{ fontSize: 12.5, color: C.midText, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{t.result.detail}</div>}
            {t.error?.reason && <div style={{ fontSize: 13, color: C.midText, lineHeight: 1.5 }}>{t.error.reason}{t.error.detail ? ` — ${t.error.detail}` : ''}</div>}
            {!t.result?.summary && !t.error?.reason && <div style={{ fontSize: 12.5, color: C.dimText }}>No recorded output.</div>}
            {/* WHY THE LAST ATTEMPT DID NOT TAKE. onResume is fire-and-forget, so
                without this the button just sat there looking untouched. */}
            {t.resumeError && !t.resuming && (
              <div style={{ fontSize: 12.5, color: '#f85149', lineHeight: 1.5 }} title={t.resumeError}>
                Couldn’t resume — {t.resumeError.startsWith('AGENT_SEPARATION_VIOLATION')
                  ? 'this session belongs to a different agent'
                  : t.resumeError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 9, marginTop: 4 }}>
              {/* Resume is seconds long (spawn → trust-accept → nudge). The label
                  and the disabled state ARE the progress indicator: previously
                  nothing on this card moved until the terminal appeared.
                  Rendered only where the registry says the backend can resume. */}
              {canResume(t) && <button onClick={() => onResume(t.id)} disabled={t.resuming}
                style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 700, color: C.bg, background: t.resuming ? '#2b6a33' : '#3fb950', border: 'none', borderRadius: 6, padding: '7px 16px', cursor: t.resuming ? 'default' : 'pointer', opacity: t.resuming ? 0.75 : 1 }}>
                {t.resuming ? 'resuming — bringing the session back…' : 'resume — continue with full context'}
              </button>}
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
    <button onClick={onClick} className={danger ? undefined : 'ow-key'}
      style={{ flex: 'none', background: 'none', border: `1px solid ${danger ? '#5b2a2e' : C.border}`, color: danger ? '#c56069' : C.midText, borderRadius: 5, fontSize: 11, padding: '3px 9px', cursor: 'pointer', fontFamily: C.mono }}>
      {label}
    </button>
  )
}

/**
 * The empty wall (spec §3.6): an agent is connected and nothing is running.
 *
 * A workspace between jobs, not an error. One microphone affordance, one example
 * phrase in the user's own vocabulary, and the last thing that finished if there
 * is one. No illustration, no "get started" ceremony.
 *
 * The key is READ, not asserted: the spec's phrase says ⌥, which is right for a
 * right-option setup and wrong for an fn one — and a first-run screen that names
 * the wrong key is the worst possible first instruction.
 */
function EmptyWall({ lastFinished, hidden, onShowAll }: { lastFinished: RemoteTask | null; hidden: number; onShowAll: () => void }) {
  const [key, setKey] = useState<'fn' | 'right-option'>('right-option')
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { remoteGetSettings?: () => Promise<{ remoteKey?: 'fn' | 'right-option' }> } }).electronAPI
    void api?.remoteGetSettings?.().then((s) => { if (s?.remoteKey) setKey(s.remoteKey) }).catch(() => {})
  }, [])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 13, padding: '46px 8px', maxWidth: 460 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden style={{ fontSize: 17 }}>🎙</span>
        <span style={{ fontSize: 14, color: C.nameText }}>
          Press {key === 'fn' ? 'fn' : '⌥'} and say what you want done.
        </span>
      </div>
      <div style={{ fontSize: 12, color: C.dimText, lineHeight: 1.55 }}>
        Nothing is running. Every task you start appears here while it works, and
        stays until you have read it.
      </div>
      {lastFinished && (
        <div style={{ fontSize: 11.5, color: C.dimText, borderTop: `1px solid ${C.border}`, paddingTop: 11 }}>
          <span style={{ color: C.faintText }}>last finished · </span>
          {nameOf(lastFinished)}
          {lastFinished.result?.summary ? <span style={{ color: C.faintText }}> — {lastFinished.result.summary}</span> : null}
        </div>
      )}
      {hidden > 0 && (
        <button onClick={onShowAll}
          style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, fontFamily: C.mono, fontSize: 11, color: '#d29922', cursor: 'pointer' }}>
          {hidden} older {hidden === 1 ? 'task is' : 'tasks are'} hidden by the 24-hour filter — show all
        </button>
      )}
    </div>
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

  // Glance vocabulary (rail): the skills archive, so the words you can SAY are
  // always in front of you. Loaded on mount, refreshed every 5 min.
  //
  // SKILLS IS A READ-ONLY ARCHIVE (decision D7). The curator that used to
  // propose new ones is off; nothing will be added to this list again. It stays
  // because what was already learned is still usable — you can say a skill's
  // name, pin one to the top, or drop it into an open terminal. No copy here
  // may imply the app is still learning, and none does.
  const [skills, setSkills] = useState<Array<{ name: string; lastUsed: string; description: string; runs?: number; pinned?: boolean; origin?: 'unmute' }>>([])
  // Signal over noise: the rail shows only the trusted top (pinned + most-used);
  // the long tail hides behind one expander so 30 skills never bury the 5 that matter.
  const [skillsExpanded, setSkillsExpanded] = useState(false)
  // Anchor coords captured at hover time — the card renders at WINDOW level
  // (position: fixed) because the rail is overflow:auto and clips anything
  // placed outside it (the bug: tooltips positioned left of the rail never showed).
  const [hoveredSkill, setHoveredSkill] = useState<{ name: string; top: number; rightPx: number } | null>(null)
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { remoteListSkills?: () => Promise<Array<{ name: string; lastUsed: string; description: string; runs?: number; pinned?: boolean; origin?: 'unmute' }>> } }).electronAPI
    const load = () => {
      void api?.remoteListSkills?.().then((s) => setSkills(s ?? [])).catch(() => {})
    }
    load()
    const i = setInterval(load, 5 * 60_000)
    return () => clearInterval(i)
  }, [])
  const togglePinSkill = useCallback((name: string, on: boolean) => {
    const api = (window as unknown as { electronAPI?: { remotePinSkill?: (n: string, on: boolean) => Promise<boolean>; remoteListSkills?: () => Promise<Array<{ name: string; lastUsed: string; description: string; runs?: number; pinned?: boolean }>> } }).electronAPI
    void api?.remotePinSkill?.(name, on).then(() => api?.remoteListSkills?.().then((s) => setSkills(s ?? [])))
  }, [])
  // Tap-to-invoke (spec §11, D14): drop `/name ` (unsubmitted) into a live session's
  // input. NEVER auto-submits — the user presses Enter. Only wired when a task
  // terminal is actually open (see openTerminalTaskId), so a stray tap can't misfire.
  const tapSkill = useCallback((taskId: string, name: string) => {
    curatorDevLog({ kind: 'skill-tap-invoke', skill: name, taskId })
    const api = (window as unknown as { electronAPI?: { curatorTapSkill?: (taskId: string, name: string) => Promise<boolean> } }).electronAPI
    void api?.curatorTapSkill?.(taskId, name)
  }, [])
  // Voice-as-doorbell toggle (§6.4): spoken headlines for needs-you states —
  // one toggle away, and the Orchestrator is fully usable dead silent.
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

  // The window title is part of the product's name (spec §2). The Orchestrator
  // window is frameless, so this is the only place the title can be set at all.
  useEffect(() => { document.title = 'Orchestrator' }, [])

  // "Clear finished" sweep cutoff — hides terminal one-offs immediately.
  const [clearedAt, setClearedAt] = useState(0)

  // THE TIME FILTER (spec §3.2). Default: the last 24 hours. `All` restores the
  // pre-filter behaviour exactly, and the control below states how many the
  // filter is currently hiding — a filter that truncates silently is forbidden.
  const [allTime, setAllTime] = useState(false)
  const visible = useMemo(() => tasks.filter((t) => visibleOnWall(t, now, clearedAt, allTime)), [tasks, now, clearedAt, allTime])
  // How many the TIME FILTER alone is hiding — everything `All` would restore,
  // not counting what is shelved or was swept by "clear finished". Computed as
  // the honest difference between the two answers of the same function.
  const hiddenByFilter = useMemo(
    () => (allTime ? 0 : tasks.filter((t) => visibleOnWall(t, now, clearedAt, true) && !visibleOnWall(t, now, clearedAt, false)).length),
    [tasks, now, clearedAt, allTime],
  )

  // GRID DENSITY (spec §3.3) — a different thing from the time filter, with a
  // different word. A group renders at most one full row of cards; the rest sit
  // behind `+N more`. Nothing here has anything to do with age.
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const [expandAll, setExpandAll] = useState(false)

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
    () => visible.filter((t) => yourMove(t.state))
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
  // Tap-to-invoke target: a skill can be inserted only when a real terminal is
  // live on the stage (a focused, alive task). Otherwise unmute-skill rows are inert.
  const openTerminalTaskId = focused?.alive ? focused.id : null

  // NEEDS YOU (spec §3.1): a task waiting on an answer outranks eleven that
  // finished, so it is lifted OUT of its router-assigned group into a band above
  // every group. Lifted, not copied — one card, one place, no double render.
  // Drawn from everything visible (not just the grid), so a waiting one-off is
  // promoted out of the rail too: the whole point is that nothing waiting on you
  // can be somewhere you are not looking.
  const needsYouBand = useMemo(() => visible.filter((t) => t.state === 'needs-user'), [visible])
  const banded = useMemo(() => new Set(needsYouBand.map((t) => t.id)), [needsYouBand])

  // Species split (§5): the grid is the space of WORKING SESSIONS; one-off
  // errands live (and resolve) in the rail. Until the user has any sessions,
  // the grid shows everything — an empty wall over a busy rail helps no one.
  // All present-tense (visibleOnWall): the past lives in History, not here.
  const rest = useMemo(() => visible.filter((t) => !banded.has(t.id)), [visible, banded])
  const sessions = useMemo(() => rest.filter((t) => t.kind === 'session'), [rest])
  const oneoffs = useMemo(() => rest.filter((t) => t.kind !== 'session'), [rest])
  const gridTasks = sessions.length ? sessions : rest
  const railOneoffs = sessions.length ? oneoffs : []
  // The Shelf: shelved tasks come from the FULL list (visibleOnWall hides them).
  const shelf = useMemo(() => tasks.filter((t) => t.shelved), [tasks])
  // The empty wall's one backward glance (§3.6) — from the WHOLE store, not the
  // visible slice, so "the last thing that finished" survives the time filter.
  const lastFinished = useMemo(
    () => tasks.filter((t) => t.state === 'done').sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null,
    [tasks],
  )

  const focus = useCallback((id: string | null) => {
    setMainFocus(id) // tell main where the voice lands BEFORE any utterance (§6.2)
    withMorph(() => { setFocusedId(id); if (id == null) setFull(false) })
  }, [])
  focusRef.current = focus

  // Clear the focus address when the wall unmounts/closes, so a stale focus can't
  // keep capturing the voice after the user leaves the Orchestrator.
  useEffect(() => () => setMainFocus(null), [])

  // Focus hygiene (the "Happy Rates!" lesson): the focused stage is the voice
  // address ONLY while the Orchestrator window itself has the user's attention. The
  // moment they switch to another app, the address is released (utterances route
  // normally); returning to the Orchestrator re-asserts it. The visual stage never
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
  // Empty queue = the BEST news the system can deliver — say so instead of a
  // silent dead button (a no-op is indistinguishable from a broken control).
  const [allClear, setAllClear] = useState(false)
  const allClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const crank = useCallback(() => {
    const q = queue
    if (q.length === 0) {
      focus(null)
      setAllClear(true)
      if (allClearTimer.current) clearTimeout(allClearTimer.current)
      allClearTimer.current = setTimeout(() => setAllClear(false), 2800)
      return
    }
    const idx = focusedId ? q.findIndex((t) => t.id === focusedId) : -1
    const nextTask = q[(idx + 1) % q.length]
    if (nextTask) focus(nextTask.id)
  }, [queue, focusedId, focus])
  useEffect(() => () => { if (allClearTimer.current) clearTimeout(allClearTimer.current) }, [])

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

  // ONE Skills section, not two (spec §3.5 — the rail is exactly four sections:
  // Queue · One-offs · Skills · Shelf). Curator-authored entries used to get a
  // second header of their own; with the curator off, "where did this come
  // from" is archive trivia and does not deserve a section. It survives as a
  // badge on the row, which still explains the origin without splitting the list.
  const renderSkillRow = (s: (typeof skills)[number]) => {
    const unmute = s.origin === 'unmute'
    const canTap = unmute && !!openTerminalTaskId
    return (
      <div
        key={s.name}
        className="ow-row"
        style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '4px 6px', margin: '0 -6px', cursor: unmute ? (canTap ? 'pointer' : 'default') : 'default' }}
        title={unmute ? (canTap ? `insert /${s.name} into the open terminal — you press Enter` : 'open a task’s terminal to insert this skill') : undefined}
        onClick={unmute ? () => { if (openTerminalTaskId) tapSkill(openTerminalTaskId, s.name) } : undefined}
        onMouseEnter={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setHoveredSkill({ name: s.name, top: r.top, rightPx: window.innerWidth - r.left + 12 })
        }}
        onMouseLeave={() => setHoveredSkill((h) => (h?.name === s.name ? null : h))}
      >
        {/* pin: hollow star always visible (dim) so the affordance is discoverable;
            bright on the hovered row; gold = pinned. stopPropagation so a pin click
            on a tappable unmute row doesn't also fire tap-to-invoke. */}
        <button
          onClick={(e) => { e.stopPropagation(); togglePinSkill(s.name, !s.pinned) }}
          title={s.pinned ? 'Unpin' : 'Pin to top'}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 15, lineHeight: 1, flex: 'none', alignSelf: 'center', color: s.pinned ? '#d29922' : hoveredSkill?.name === s.name ? C.nameText : C.midText }}
        >{s.pinned ? '★' : '☆'}</button>
        <span style={{ fontSize: 11.5, color: hoveredSkill?.name === s.name ? C.nameText : C.midText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{s.name}</span>
        {unmute && (
          <span title="Written by Unmute's skill curator, which is switched off — this archive is fixed." style={{ fontSize: 8.5, letterSpacing: 0.4, textTransform: 'uppercase', color: '#39c5cf', border: '1px solid rgba(57,197,207,0.35)', borderRadius: 4, padding: '0 4px', flex: 'none', alignSelf: 'center' }}>unmute</span>
        )}
        <span style={{ fontSize: 10, color: C.faintText, flex: 'none' }}>{(s.runs ?? 0) > 0 ? `${s.runs}×` : s.lastUsed ? s.lastUsed.slice(5, 10) : ''}</span>
      </div>
    )
  }

  return (
    <div
      style={{ position: 'absolute', inset: 0, background: C.bg, color: C.midText, fontFamily: C.mono, display: 'flex', flexDirection: 'column', padding: '14px 16px 16px' }}
    >
      {/* ─── HEADER (spec §2, §3.2, §3.4) ───
          The surface names itself, and carries the two controls that govern what
          the wall is showing: the TIME filter and grid density's Expand all. */}
      {!full && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '2px 2px 11px', flex: 'none' }}>
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.6, color: C.nameText }}>Orchestrator</span>
          {!focused && (
            <span style={{ fontSize: 10.5, color: C.faintText }}>
              {visible.length} {visible.length === 1 ? 'task' : 'tasks'}
            </span>
          )}

          {/* The two controls govern the GRID, so they stand down while a stage
              is open — the wall they act on is not on screen. The title stays. */}
          <div style={{ marginLeft: 'auto', display: focused ? 'none' : 'flex', alignItems: 'center', gap: 8 }}>
            {/* TIME FILTER. Reversible, and it says what it is hiding — a wall
                that quietly drops your work is worse than one that is busy. */}
            <button onClick={() => setAllTime((v) => !v)} className="ow-key"
              title={allTime
                ? 'Showing every task the store still holds. Click for the last 24 hours.'
                : 'Showing tasks that are live now or were touched in the last 24 hours. Click to show everything.'}
              style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: `1px solid ${C.border}`, color: C.midText, borderRadius: 5, fontSize: 11, padding: '3px 9px', cursor: 'pointer', fontFamily: C.mono }}>
              <span>{allTime ? 'All' : 'Last 24h'}</span>
              {!allTime && hiddenByFilter > 0 && (
                <span style={{ color: '#d29922' }}>· {hiddenByFilter} older hidden</span>
              )}
              <span style={{ color: C.faintText }}>▾</span>
            </button>

            {/* GRID DENSITY. Idempotent by construction: it only ever SETS
                expanded. Pressing it twice cannot collapse anything; the
                separate Collapse control is the only way back. */}
            <button
              onClick={() => { setExpandAll(true); setExpandedGroups(new Set()) }}
              className="ow-key"
              title="Show every card in every group. Does not change the time filter."
              style={{ background: 'none', border: `1px solid ${C.border}`, color: expandAll ? C.faintText : C.midText, borderRadius: 5, fontSize: 11, padding: '3px 9px', cursor: 'pointer', fontFamily: C.mono }}>
              Expand all
            </button>
            {(expandAll || expandedGroups.size > 0) && (
              <button onClick={() => { setExpandAll(false); setExpandedGroups(new Set()) }} className="ow-key"
                style={{ background: 'none', border: `1px solid ${C.border}`, color: C.midText, borderRadius: 5, fontSize: 11, padding: '3px 9px', cursor: 'pointer', fontFamily: C.mono }}>
                Collapse
              </button>
            )}
          </div>
        </div>
      )}

      {/* tap banner — highest-priority queued item, always at the top (§8) */}
      {top && needsYou(top.state) && !full && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface, flex: 'none' }}>
          <Dot state={top.state} />
          <span style={{ fontSize: 12.5, color: C.nameText, fontWeight: 600, flex: 'none' }}>{nameOf(top)}</span>
          <span style={{ fontSize: 12, color: C.midText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>— {activityLine(top)}</span>
          <button onClick={() => focus(top.id)} className="ow-banner-btn"
            style={{ marginLeft: 'auto', flex: 'none', fontFamily: C.mono, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: C.bg, background: statusOf(top.state).color, border: 'none', borderRadius: 5, padding: '5px 12px', cursor: 'pointer' }}>
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
              {/* ─── NEEDS YOU (spec §3.1) ───
                  Above every group, because one task waiting on an answer
                  outranks eleven that finished. Empty → nothing renders at all:
                  no header, no rule, no gap. */}
              {needsYouBand.length > 0 && (
                <div style={{ marginBottom: 26 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
                    <span style={{ width: 7, height: 7, borderRadius: 9999, background: STATUS['needs-user'].color, boxShadow: `0 0 7px ${STATUS['needs-user'].color}` }} />
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: STATUS['needs-user'].color, textTransform: 'uppercase' }}>
                      needs you · {needsYouBand.length}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(248px, 1fr))', gap: 11, alignContent: 'start' }}>
                    {needsYouBand.map((t) => (
                      <Card key={t.id} t={t} now={now} attention queuePos={queuePos.get(t.id) ?? null}
                        promoted={(promotedAt.get(t.id) ?? 0) > now - 8000} onClick={() => focus(t.id)} />
                    ))}
                  </div>
                </div>
              )}

              {/* Group sections (spec 2026-07-16): position encodes what the
                  work is ABOUT. Zero named groups → exactly the old flat grid.
                  Store order is newest-first, so newest renders left. */}
              {gridTasks.length === 0 && needsYouBand.length === 0 && <EmptyWall lastFinished={lastFinished} hidden={hiddenByFilter} onShowAll={() => setAllTime(true)} />}
              {groupSections(gridTasks).map((sec, i) => {
                const key = sec.name ?? '·ungrouped'
                const open = expandAll || expandedGroups.has(key)
                const shown = open ? sec.tasks : sec.tasks.slice(0, GRID_ROW)
                const more = sec.tasks.length - shown.length
                return (
                  <div key={key} style={{ marginTop: i === 0 ? 0 : 28 }}>
                    {sec.name != null && (
                      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: C.dimText, textTransform: 'uppercase', marginBottom: 6 }}>{sec.name}</div>
                    )}
                    {sec.name == null && i > 0 && (
                      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: C.faintText, textTransform: 'uppercase', marginBottom: 6 }}>ungrouped</div>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(248px, 1fr))', gap: 11, alignContent: 'start' }}>
                      {shown.map((t) => <Card key={t.id} t={t} now={now} queuePos={queuePos.get(t.id) ?? null} promoted={(promotedAt.get(t.id) ?? 0) > now - 8000} onClick={() => focus(t.id)} />)}
                    </div>
                    {/* GRID DENSITY, not time (spec §3.3). A different verb and a
                        different shape from `Last 24h`, so it cannot be misread
                        as a second time filter. */}
                    {more > 0 && (
                      <button onClick={() => setExpandedGroups((s) => new Set(s).add(key))}
                        style={{ marginTop: 8, background: 'none', border: 'none', padding: 0, fontFamily: C.mono, fontSize: 11, color: C.dimText, cursor: 'pointer' }}>
                        +{more} more
                      </button>
                    )}
                    {open && sec.tasks.length > GRID_ROW && !expandAll && (
                      <button onClick={() => setExpandedGroups((s) => { const n = new Set(s); n.delete(key); return n })}
                        style={{ marginTop: 8, background: 'none', border: 'none', padding: 0, fontFamily: C.mono, fontSize: 11, color: C.faintText, cursor: 'pointer' }}>
                        show less
                      </button>
                    )}
                  </div>
                )
              })}
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
                    <button key={t.id} onClick={() => focus(t.id)} className="ow-row"
                      style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', margin: '0 -6px', fontFamily: C.mono }}>
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
                      {hiddenByFilter > 0 ? `${hiddenByFilter} older — switch to All, or see History` : 'short-lived tasks resolve here'}
                    </div>
                  )}
                  {railOneoffs.map((t) => (
                    <button key={t.id} onClick={() => focus(t.id)} className="ow-row"
                      style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', margin: '0 -6px', fontFamily: C.mono }}>
                      <Dot state={t.state} />
                      <span style={{ fontSize: 11.5, color: C.midText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{nameOf(t)}</span>
                      <span style={{ fontSize: 10, color: C.faintText, flex: 'none' }}>{elapsed(t.createdAt, now)}</span>
                    </button>
                  ))}
                </RailSection>
                {/* SKILLS — a READ-ONLY ARCHIVE (decision D7). What was already
                    learned, still usable: say a name, pin one, or drop it into an
                    open terminal. Nothing is added to it any more, and no copy
                    here suggests otherwise. Always rendered: it is one of the
                    rail's four fixed sections, so it must not vanish when empty. */}
                <RailSection title={`Skills · ${skills.length}`}>
                  {skills.length === 0 && <div style={{ fontSize: 11, color: C.faintText }}>no skills on this machine</div>}
                  {/* glance vocabulary — say a skill's name to use it. Hover →
                      a card with the FULL name + the skill's own description,
                      so 'should I invoke this?' is answerable at a glance.
                      Ranked pinned → proven use → recency (main side); collapsed
                      to the trusted top 6 with the tail behind "N more". */}
                  {(skillsExpanded ? skills : skills.slice(0, 6)).map((s) => renderSkillRow(s))}
                  {skills.length > 6 && (
                    <button onClick={() => setSkillsExpanded((v) => !v)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', margin: '0 -6px', textAlign: 'left', fontFamily: C.mono, fontSize: 10.5, color: C.faintText }}>
                      {skillsExpanded ? '· show less' : `· ${skills.length - 6} more…`}
                    </button>
                  )}
                </RailSection>
                <RailSection title={`Shelf · ${shelf.length}`}>
                    {shelf.length === 0 && <div style={{ fontSize: 11, color: C.faintText }}>kept-but-out-of-the-way tasks land here</div>}
                    {/* kept-but-out-of-the-way — findable, never on the wall.
                        Click a row to open it on the stage; ⌃ puts it back. */}
                    {shelf.map((t) => (
                      <div key={t.id} className="ow-row" style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '4px 6px', margin: '0 -6px' }}>
                        <button onClick={() => focus(t.id)} title={t.note || t.intent}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', fontFamily: C.mono, fontSize: 11.5, color: C.midText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                          {nameOf(t)}
                        </button>
                        <button
                          onClick={() => {
                            const api = (window as unknown as { electronAPI?: { remoteSetShelved?: (id: string, on: boolean) => Promise<boolean> } }).electronAPI
                            void api?.remoteSetShelved?.(t.id, false)
                          }}
                          title="Unshelve — back onto the wall"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: C.mono, fontSize: 10.5, color: C.faintText, flex: 'none' }}
                        >⌃</button>
                      </div>
                    ))}
                </RailSection>
              </>
            )}
          </div>
        )}
      </div>

      {/* all-clear beat — the crank's honest end state */}
      {allClear && (
        <div style={{ position: 'absolute', top: 52, left: '50%', transform: 'translateX(-50%)', zIndex: 50, fontFamily: C.mono, fontSize: 12.5, color: '#3fb950', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 9999, padding: '7px 16px', pointerEvents: 'none' }}>
          ✓ all clear — nothing needs you
        </div>
      )}

      {/* skill hover card — WINDOW level (fixed) so the scrollable rail can't clip it */}
      {hoveredSkill && (() => {
        const sk = skills.find((x) => x.name === hoveredSkill.name)
        if (!sk) return null
        return (
          <div style={{
            position: 'fixed', right: hoveredSkill.rightPx, top: Math.max(10, Math.min(hoveredSkill.top - 6, window.innerHeight - 180)), width: 300, zIndex: 60,
            background: 'rgba(21, 24, 29, 0.96)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
            border: `1px solid ${C.borderHi}`, borderRadius: 9, padding: '11px 13px',
            pointerEvents: 'none', fontFamily: C.mono,
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.nameText, marginBottom: 5, wordBreak: 'break-all' }}>{sk.name}</div>
            <div style={{ fontSize: 11.5, color: C.midText, lineHeight: 1.55, whiteSpace: 'normal' }}>
              {sk.description || 'No description in this skill\u2019s frontmatter.'}
            </div>
            <div style={{ fontSize: 10, color: C.faintText, marginTop: 7 }}>last used {sk.lastUsed || 'unknown'} · say its name to use it</div>
          </div>
        )
      })()}

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
      <style>{`
        @keyframes wall-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.25 } }
        @keyframes ow-fade-in { from { opacity: 0; transform: translateY(3px) } to { opacity: 1; transform: none } }
        ::-webkit-scrollbar { width: 8px; height: 8px }
        ::-webkit-scrollbar-thumb { background: #23272e; border-radius: 4px }
        ::-webkit-scrollbar-thumb:hover { background: #323843 }
        ::-webkit-scrollbar-corner { background: transparent }
        .ow-card { transition: border-color 140ms ease, background 140ms ease, transform 140ms ease; animation: ow-fade-in 180ms ease }
        .ow-card:hover { border-color: #3a4150 !important; background: #181c22 !important; transform: translateY(-1px) }
        .ow-card:active { transform: none }
        .ow-key { transition: color 120ms ease, border-color 120ms ease, background 120ms ease }
        .ow-key:hover { color: #e8eaed !important; border-color: #3a4150 !important; background: rgba(255,255,255,0.04) }
        .ow-row { border-radius: 5px; transition: background 120ms ease }
        .ow-row:hover { background: rgba(255,255,255,0.045) }
        .ow-banner-btn { transition: filter 120ms ease }
        .ow-banner-btn:hover { filter: brightness(1.15) }
      `}</style>
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

      {/* The Skill Curator review popup used to mount here, opened from the
          curator's review-inbox rail section. That section is gone (decision D7
          — with the curator off it can never receive another proposal), and the
          popup went with it rather than sitting in the tree unreachable. */}
    </div>
  )
}
