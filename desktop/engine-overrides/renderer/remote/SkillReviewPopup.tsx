// Skill Curator — the center review popup (spec §11, Task 14).
//
// Where a proposed skill earns its place: the user READS the draft (a whole new
// SKILL.md) or the DIFF (an edit to an existing one), sees the EVIDENCE that
// justified it (how often the pattern recurred, across how many sessions, how
// much wall-clock struggle), and can CONVERSE with a real Claude Code session to
// ask why / edit it — then Accepts (writes it to ~/.claude/skills) or Rejects.
//
// Idiom match (OrchestrateWall): INLINE styles, the same `C` Ops-Console palette,
// mono type. This is a modal — full-screen scrim + a centered card. Clicking the
// scrim or the close [x] is CANCEL, not reject: the proposal stays pending.

import { useCallback, useEffect, useRef, useState } from 'react'

// ─── Same neutral palette OrchestrateWall uses (kept local; this is a sibling). ───
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
// Curator hue = amber (the "needs a decision" color the rail uses for suggestions).
const AMBER = '#d29922'
const GREEN = '#3fb950'
const RED = '#f85149'

// The Proposal shape mirrors electron/remote/curator-store.ts (Proposal + nested).
// Held here read-only; the popup never mutates it (the conversation edits the
// draft on disk; a fresh curatorGetProposal isn't needed — accept reads disk).
interface Proposal {
  id: string
  sweepId: string
  proposedAt: string
  kind: 'create' | 'update'
  draft: { name: string; description: string; body: string }
  evidence: {
    occurrences: number
    sessions: Array<{ id: string; intent: string; at: string; tracePointer: string }>
    firstSeen: string
    lastSeen: string
    struggle: { errors: number; recoveries: number; wallClockMin: number }
  }
  rationale: string
  targetSkill?: string
  diff?: string
  triggeringEvidence?: string[]
  affectedSessions?: Array<{ id: string; invokedAt: string }>
  resolution: null | { action: 'accepted' | 'rejected'; at: string; userEdited: boolean; reason?: string }
}

// The IPC surface this popup consumes (all added in Task 12, mirrored in preload).
interface CuratorAPI {
  curatorGetProposal?: (id: string) => Promise<Proposal | null>
  curatorAccept?: (id: string) => Promise<{ ok: boolean; error?: string }>
  curatorReject?: (id: string, reason?: string) => Promise<boolean>
  curatorConverseStart?: (id: string) => Promise<boolean>
  curatorConverseWrite?: (id: string, data: string) => Promise<void>
  curatorConverseStop?: (id: string) => Promise<void>
  curatorOnConvData?: (cb: (d: { id: string; chunk: string }) => void) => () => void
}
function curatorApi(): CuratorAPI | undefined {
  return (window as unknown as { electronAPI?: CuratorAPI }).electronAPI
}

// Terminals speak in ANSI: strip CSI cursor/color codes and OSC title sequences so
// the scrollback reads as plain text (we render Claude's words, not its redraws).
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // CSI (colors, cursor moves)
    .replace(/\x1b\][^\x07]*\x07/g, '') // OSC (window title etc.)
    .replace(/\x1b[=>]/g, '') // keypad mode
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '') // stray control bytes (keep \n \r \t)
}

export default function SkillReviewPopup({ proposalId, onClose }: { proposalId: string; onClose: () => void }) {
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // On mount: pull the full proposal (draft body, evidence, diff) from main.
  useEffect(() => {
    let live = true
    const api = curatorApi()
    if (!api?.curatorGetProposal) { setLoadError('curator IPC unavailable'); return }
    void api.curatorGetProposal(proposalId).then((p) => {
      if (!live) return
      if (p) setProposal(p)
      else setLoadError('proposal not found — it may have been resolved already')
    }).catch(() => { if (live) setLoadError('could not load proposal') })
    return () => { live = false }
  }, [proposalId])

  // ─── Conversation pane state ───
  const [discussing, setDiscussing] = useState(false)
  const [convText, setConvText] = useState('')
  const [input, setInput] = useState('')
  const startedRef = useRef(false) // guard: start the CC session exactly once
  const scrollRef = useRef<HTMLPreElement | null>(null)

  // Subscribe to conversation chunks FOR THIS PROPOSAL for the popup's whole life,
  // and start/stop the underlying CC session with the discuss toggle. The listener
  // is filtered by id so a chunk from another proposal's session never appends here.
  useEffect(() => {
    const api = curatorApi()
    const off = api?.curatorOnConvData?.((d) => {
      if (d.id !== proposalId) return
      setConvText((prev) => prev + stripAnsi(d.chunk))
    })
    return () => { off?.() }
  }, [proposalId])

  // On popup close/unmount: always stop the conversation (frees the CC session).
  useEffect(() => {
    return () => { void curatorApi()?.curatorConverseStop?.(proposalId) }
  }, [proposalId])

  // First time the user opens "discuss / edit": spawn the real CC session.
  const openDiscuss = useCallback(() => {
    setDiscussing(true)
    if (startedRef.current) return
    startedRef.current = true
    void curatorApi()?.curatorConverseStart?.(proposalId)
  }, [proposalId])

  // Keep the scrollback pinned to the newest output.
  useEffect(() => {
    if (discussing && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [convText, discussing])

  const sendLine = useCallback(() => {
    const v = input
    if (!v.trim()) return
    void curatorApi()?.curatorConverseWrite?.(proposalId, v + '\r')
    setInput('')
  }, [input, proposalId])

  // ─── Accept / Reject state ───
  const [busy, setBusy] = useState(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  const accept = useCallback(() => {
    setBusy(true)
    setAcceptError(null)
    const api = curatorApi()
    if (!api?.curatorAccept) { setBusy(false); setAcceptError('curator IPC unavailable'); return }
    void api.curatorAccept(proposalId).then((res) => {
      if (res?.ok) { onClose(); return }
      // Failure keeps the popup open and shows the message inline (e.g. a name
      // collision → the user should discuss a rename, not lose their place).
      const raw = res?.error || 'could not accept — try again'
      setAcceptError(/exist|collision|taken/i.test(raw) ? `${raw} — discuss a rename` : raw)
      setBusy(false)
    }).catch(() => { setAcceptError('could not accept — try again'); setBusy(false) })
  }, [proposalId, onClose])

  const reject = useCallback(() => {
    setBusy(true)
    const reason = rejectReason.trim() || undefined
    void curatorApi()?.curatorReject?.(proposalId, reason).finally(() => onClose())
  }, [proposalId, rejectReason, onClose])

  // Esc anywhere = Cancel (proposal stays pending). Inputs stopPropagation on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const kindChip = proposal?.kind === 'update'
    ? { label: 'skill edit', color: AMBER }
    : { label: 'new skill', color: GREEN }

  return (
    // Scrim — click anywhere outside the panel = Cancel.
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)', fontFamily: C.mono,
      }}
    >
      {/* Panel — clicks inside stay inside (don't bubble to the scrim's Cancel). */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(640px, 92vw)', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
          background: '#111318', border: `1px solid ${C.borderHi}`, borderRadius: 16,
          boxShadow: '0 24px 64px rgba(0,0,0,0.55)', overflow: 'hidden',
        }}
      >
        {/* ── Header: kind chip + draft name + close ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: `1px solid ${C.border}`, flex: 'none' }}>
          <span style={{
            fontSize: 9.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: kindChip.color,
            border: `1px solid ${kindChip.color}55`, borderRadius: 5, padding: '2px 7px', flex: 'none',
          }}>{kindChip.label}</span>
          <span style={{ fontSize: 14.5, fontWeight: 700, color: C.nameText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {proposal?.draft.name ?? '…'}
          </span>
          <button onClick={onClose} title="Cancel — keeps the proposal pending"
            style={{ marginLeft: 'auto', flex: 'none', background: 'none', border: `1px solid ${C.border}`, color: C.midText, borderRadius: 5, fontSize: 13, lineHeight: 1, padding: '3px 8px', cursor: 'pointer', fontFamily: C.mono }}>
            ✕
          </button>
        </div>

        {loadError ? (
          <div style={{ padding: '28px 18px', fontSize: 12.5, color: C.midText }}>{loadError}</div>
        ) : !proposal ? (
          <div style={{ padding: '28px 18px', fontSize: 12.5, color: C.dimText }}>loading proposal…</div>
        ) : (
          <>
            {/* ── Evidence strip: why this earned a review ── */}
            <div style={{ padding: '11px 16px', borderBottom: `1px solid ${C.border}`, flex: 'none', background: C.surface }}>
              <div style={{ fontSize: 11, color: AMBER, fontWeight: 600, letterSpacing: 0.2 }}>
                seen {proposal.evidence.occurrences}× · {proposal.evidence.sessions.length} session{proposal.evidence.sessions.length === 1 ? '' : 's'} · {proposal.evidence.struggle.wallClockMin}min of work
              </div>
              {proposal.rationale && (
                <div style={{ fontSize: 12, color: C.midText, lineHeight: 1.55, marginTop: 6 }}>{proposal.rationale}</div>
              )}
            </div>

            {/* ── Body: full draft (create) or unified diff (update) ── */}
            <div style={{ flex: 1, minHeight: 120, overflow: 'auto', padding: '12px 16px' }}>
              {proposal.kind === 'create' ? (
                <pre style={{ margin: 0, fontFamily: C.mono, fontSize: 12, lineHeight: 1.55, color: C.nameText, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {proposal.draft.body}
                </pre>
              ) : proposal.diff ? (
                <pre style={{ margin: 0, fontFamily: C.mono, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {proposal.diff.split('\n').map((line, i) => {
                    const isMeta = line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')
                    const color = isMeta ? C.dimText
                      : line.startsWith('+') ? GREEN
                      : line.startsWith('-') ? RED
                      : C.midText
                    const bg = isMeta ? 'transparent'
                      : line.startsWith('+') ? 'rgba(63,185,80,0.08)'
                      : line.startsWith('-') ? 'rgba(248,81,73,0.08)'
                      : 'transparent'
                    return (
                      <div key={i} style={{ color, background: bg, padding: '0 4px', margin: '0 -4px' }}>{line || ' '}</div>
                    )
                  })}
                </pre>
              ) : (
                <div style={{ fontSize: 12, color: C.dimText, fontStyle: 'italic' }}>
                  no diff was recorded for this edit — discuss it below to see the intended change
                </div>
              )}
            </div>

            {/* ── Conversation pane (behind the discuss / edit toggle) ── */}
            <div style={{ borderTop: `1px solid ${C.border}`, flex: 'none' }}>
              {!discussing ? (
                <button onClick={openDiscuss}
                  style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontFamily: C.mono, fontSize: 11.5, color: C.midText, padding: '9px 16px' }}>
                  💬 discuss / edit — ask why, or tell it to change the draft
                </button>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', padding: '10px 16px 12px', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1, color: C.dimText, textTransform: 'uppercase' }}>conversation</span>
                    <span style={{ fontSize: 10, color: C.faintText }}>a real Claude Code session — edits change the draft on disk</span>
                    <button onClick={() => setDiscussing(false)} title="Hide (session keeps running)"
                      style={{ marginLeft: 'auto', background: 'none', border: 'none', color: C.dimText, cursor: 'pointer', fontFamily: C.mono, fontSize: 11 }}>
                      hide
                    </button>
                  </div>
                  <pre ref={scrollRef}
                    style={{ margin: 0, height: 150, overflow: 'auto', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7, padding: '8px 10px', fontFamily: C.mono, fontSize: 11.5, lineHeight: 1.5, color: C.midText, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {convText || 'starting session…'}
                  </pre>
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { e.stopPropagation(); return }
                      if (e.key === 'Enter') { e.preventDefault(); sendLine() }
                    }}
                    placeholder="e.g. make the description shorter, then press Enter"
                    style={{ fontFamily: C.mono, fontSize: 12, color: C.nameText, background: C.surfaceHi, border: `1px solid ${C.borderHi}`, borderRadius: 6, padding: '7px 10px', outline: 'none' }}
                  />
                </div>
              )}
            </div>

            {/* ── Footer: Accept / Reject ── */}
            <div style={{ borderTop: `1px solid ${C.border}`, padding: '12px 16px', flex: 'none', display: 'flex', flexDirection: 'column', gap: 9 }}>
              {acceptError && (
                <div style={{ fontSize: 11.5, color: RED, lineHeight: 1.5 }}>{acceptError}</div>
              )}
              {rejecting && (
                <input
                  autoFocus
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') { e.stopPropagation(); setRejecting(false) }
                    if (e.key === 'Enter') { e.preventDefault(); reject() }
                  }}
                  placeholder="why? (optional — helps the curator not re-suggest it)"
                  style={{ fontFamily: C.mono, fontSize: 12, color: C.nameText, background: C.surfaceHi, border: `1px solid ${C.borderHi}`, borderRadius: 6, padding: '7px 10px', outline: 'none' }}
                />
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <button onClick={accept} disabled={busy}
                  style={{ fontFamily: C.mono, fontSize: 12.5, fontWeight: 700, color: C.bg, background: GREEN, border: 'none', borderRadius: 7, padding: '8px 18px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
                  Accept
                </button>
                {rejecting ? (
                  <button onClick={reject} disabled={busy}
                    style={{ fontFamily: C.mono, fontSize: 12, color: '#c56069', background: 'none', border: '1px solid #5b2a2e', borderRadius: 7, padding: '8px 16px', cursor: busy ? 'default' : 'pointer' }}>
                    confirm reject
                  </button>
                ) : (
                  <button onClick={() => setRejecting(true)} disabled={busy}
                    style={{ fontFamily: C.mono, fontSize: 12, color: C.midText, background: 'none', border: `1px solid ${C.border}`, borderRadius: 7, padding: '8px 16px', cursor: 'pointer' }}>
                    Reject
                  </button>
                )}
                <button onClick={onClose} disabled={busy}
                  style={{ marginLeft: 'auto', fontFamily: C.mono, fontSize: 11.5, color: C.dimText, background: 'none', border: 'none', cursor: 'pointer' }}>
                  cancel — keep pending
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
