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
  kind: 'create' | 'narrow' | 'split' | 'merge' | 'retire'
  draft: { name: string; description: string; body: string }
  evidence: {
    occurrences: number
    sessions: Array<{ id: string; intent: string; at: string; tracePointer: string }>
    firstSeen: string
    lastSeen: string
    struggle: { errors: number; recoveries: number; wallClockMin: number }
  }
  rationale: string
  changeSummary?: string[]
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

// DEV-ONLY full-UX logging: emit a structured curator event for every user-facing
// action in the review popup. UNCONDITIONAL — main holds the single gate and drops
// it when off, so a packaged build logs nothing. Payloads stay small + structured.
function curatorDevLog(payload: Record<string, unknown>) {
  const api = (window as unknown as { electronAPI?: { curatorDevLog?: (p: Record<string, unknown>) => void } }).electronAPI
  api?.curatorDevLog?.(payload)
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
      if (p) { setProposal(p); curatorDevLog({ kind: 'popup-open', proposalId, proposalKind: p.kind, name: p.draft.name }) }
      else setLoadError('proposal not found — it may have been resolved already')
    }).catch(() => { if (live) setLoadError('could not load proposal') })
    return () => { live = false }
  }, [proposalId])

  // ─── Raw diff/body toggle (collapsed by default — the summary leads, D20) ───
  const [showRaw, setShowRaw] = useState(false)

  // ─── Conversation state (the PRIMARY edit affordance — always visible, D20) ───
  const [convText, setConvText] = useState('')
  const [input, setInput] = useState('')
  const startedRef = useRef(false) // guard: start the CC session exactly once
  const scrollRef = useRef<HTMLPreElement | null>(null)

  // Subscribe to conversation chunks FOR THIS PROPOSAL for the popup's whole life.
  // The listener is filtered by id so a chunk from another proposal's session never
  // appends here. (Subscription is lifecycle-independent of when the CC session
  // actually starts — we start it lazily on the user's first message.)
  useEffect(() => {
    const api = curatorApi()
    const off = api?.curatorOnConvData?.((d) => {
      if (d.id !== proposalId) return
      // DEV-ONLY: log activity only (chunk length, not content — the content is
      // the CC session's raw output; keep the UX log small + non-sensitive).
      curatorDevLog({ kind: 'conversation-activity', proposalId, chars: d.chunk.length })
      setConvText((prev) => prev + stripAnsi(d.chunk))
    })
    return () => { off?.() }
  }, [proposalId])

  // On popup close/unmount: always stop the conversation (frees the CC session).
  useEffect(() => {
    return () => { void curatorApi()?.curatorConverseStop?.(proposalId) }
  }, [proposalId])

  // Spawn the real CC session lazily — on the user's first message. The edit box is
  // always visible (D20), but we don't pay for a session until they actually engage.
  const ensureStarted = useCallback(() => {
    if (startedRef.current) return
    startedRef.current = true
    void curatorApi()?.curatorConverseStart?.(proposalId)
  }, [proposalId])

  // Keep the scrollback pinned to the newest output.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [convText])

  const sendLine = useCallback(() => {
    const v = input
    if (!v.trim()) return
    curatorDevLog({ kind: 'conversation-instruction', proposalId, text: v })
    ensureStarted()
    void curatorApi()?.curatorConverseWrite?.(proposalId, v + '\r')
    setInput('')
  }, [input, proposalId, ensureStarted])

  // ─── Accept / Reject state ───
  const [busy, setBusy] = useState(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  const accept = useCallback(() => {
    setBusy(true)
    setAcceptError(null)
    curatorDevLog({ kind: 'accept-click', proposalId })
    const api = curatorApi()
    if (!api?.curatorAccept) { setBusy(false); setAcceptError('curator IPC unavailable'); return }
    void api.curatorAccept(proposalId).then((res) => {
      if (res?.ok) { curatorDevLog({ kind: 'accept-result', proposalId, ok: true }); onClose(); return }
      // Failure keeps the popup open and shows the message inline (e.g. a name
      // collision → the user should discuss a rename, not lose their place).
      const raw = res?.error || 'could not accept — try again'
      curatorDevLog({ kind: 'accept-result', proposalId, ok: false, error: raw })
      setAcceptError(/exist|collision|taken/i.test(raw) ? `${raw} — discuss a rename` : raw)
      setBusy(false)
    }).catch(() => { curatorDevLog({ kind: 'accept-result', proposalId, ok: false, error: 'threw' }); setAcceptError('could not accept — try again'); setBusy(false) })
  }, [proposalId, onClose])

  const reject = useCallback(() => {
    setBusy(true)
    const reason = rejectReason.trim() || undefined
    curatorDevLog({ kind: 'reject-click', proposalId, reason })
    void curatorApi()?.curatorReject?.(proposalId, reason).finally(() => onClose())
  }, [proposalId, rejectReason, onClose])

  // Cancel/close (proposal stays pending) — distinct from accept/reject, which
  // resolve it. DEV-ONLY log so the timeline shows the user backed out.
  const cancel = useCallback(() => {
    curatorDevLog({ kind: 'popup-cancel', proposalId })
    onClose()
  }, [proposalId, onClose])

  // Esc anywhere = Cancel (proposal stays pending). Inputs stopPropagation on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancel])

  const KIND_CHIP: Record<Proposal['kind'], { label: string; color: string }> = {
    create: { label: 'new skill', color: GREEN },
    narrow: { label: 'narrow', color: AMBER },
    split: { label: 'split', color: AMBER },
    merge: { label: 'merge', color: AMBER },
    retire: { label: 'retire', color: RED },
  }
  const kindChip = proposal ? KIND_CHIP[proposal.kind] : { label: 'new skill', color: GREEN }

  // Kind-aware, human, first-person-from-the-user's-side summary line (Task 12):
  // this is what the user reads FIRST to understand what's being asked of them,
  // ahead of the bullets/rationale below.
  function kindSummaryLine(p: Proposal): string {
    const target = p.targetSkill ?? p.draft.name
    switch (p.kind) {
      case 'create': return `New skill: ${p.draft.name}`
      case 'narrow': return `Narrow ${target} to the part you actually repeat`
      case 'split': return `Split ${target} into two`
      case 'merge': return `Merge into ${target}`
      case 'retire': return `Retire ${target}`
      default: return p.rationale
    }
  }

  // The plain-language summary the user reads to decide (D20). Empty/missing →
  // fall back to the rationale so the primary area is never blank.
  const summaryBullets = (proposal?.changeSummary ?? []).filter((s) => typeof s === 'string' && s.trim().length > 0)
  // Rewrite kinds carry a full replacement body diffed against the current one
  // (D19, deterministic — computed in curator.ts, never LLM-authored).
  const REWRITE_KINDS = new Set<Proposal['kind']>(['narrow', 'split', 'merge'])

  return (
    // Scrim — click anywhere outside the panel = Cancel.
    <div
      onClick={cancel}
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
          <button onClick={cancel} title="Cancel — keeps the proposal pending"
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
            </div>

            {/* PRIMARY: plain-language summary of the change (D20). This is what the
                user reads to decide. Kind-aware headline first, then changeSummary
                bullets, else the rationale. */}
            <div style={{ flex: 1, minHeight: 96, overflow: 'auto', padding: '14px 16px' }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: C.nameText, lineHeight: 1.5, marginBottom: summaryBullets.length > 0 || proposal.rationale ? 8 : 0 }}>
                {kindSummaryLine(proposal)}
              </div>
              {summaryBullets.length > 0 ? (
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {summaryBullets.map((b, i) => (
                    <li key={i} style={{ display: 'flex', gap: 9, fontSize: 13, lineHeight: 1.55, color: C.nameText }}>
                      <span style={{ flex: 'none', color: AMBER }}>{'•'}</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div style={{ fontSize: 13, color: C.nameText, lineHeight: 1.6 }}>{proposal.rationale}</div>
              )}
            </div>

            {/* Raw diff/body behind a toggle, collapsed by default. NOTE: the diff
                (D19, deterministic) and the summary describe Unmute's ORIGINAL
                proposal. If the user refines draft.md via the conversation below,
                these are NOT live-recomputed -- they show the original (the user drove
                those edits, so they know them). Accept always writes the CURRENT
                draft.md on disk regardless of what's shown here.
                `retire` has no body/diff to preview (it deletes a skill) — the
                evidence strip + rationale above already say everything there is,
                so this whole toggle is omitted for that kind. */}
            {proposal.kind !== 'retire' && (
            <div style={{ borderTop: `1px solid ${C.border}`, flex: 'none' }}>
              <button onClick={() => setShowRaw((v) => { curatorDevLog({ kind: 'show-raw-toggle', proposalId, show: !v, view: REWRITE_KINDS.has(proposal.kind) ? 'diff' : 'details' }); return !v })}
                style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontFamily: C.mono, fontSize: 11.5, color: C.midText, padding: '9px 16px' }}>
                {showRaw ? '▾ ' : '▸ '}{REWRITE_KINDS.has(proposal.kind) ? (showRaw ? 'Hide diff' : 'Show diff') : (showRaw ? 'Hide details' : 'Show details')}
              </button>
              {showRaw && (
                <div style={{ maxHeight: 220, overflow: 'auto', padding: '2px 16px 12px' }}>
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
                          <div key={i} style={{ color, background: bg, padding: '0 4px', margin: '0 -4px' }}>{line || ' '}</div>
                        )
                      })}
                    </pre>
                  ) : (
                    <div style={{ fontSize: 12, color: C.dimText, fontStyle: 'italic' }}>
                      no diff was recorded for this edit -- tell me below to see the intended change
                    </div>
                  )}
                </div>
              )}
            </div>
            )}

            {/* PRIMARY edit affordance: natural-language editing (D20). The user tells
                this Claude Code session what to change; it rewrites draft.md. The user
                never hand-types skill markdown. Always visible. */}
            <div style={{ borderTop: `1px solid ${C.border}`, flex: 'none', display: 'flex', flexDirection: 'column', padding: '11px 16px 12px', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: C.nameText }}>Tell me what to change</span>
                <span style={{ fontSize: 10.5, color: C.dimText }}>{'— I’ll rewrite it (a real Claude Code session)'}</span>
              </div>
              {convText && (
                <pre ref={scrollRef}
                  style={{ margin: 0, maxHeight: 150, overflow: 'auto', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7, padding: '8px 10px', fontFamily: C.mono, fontSize: 11.5, lineHeight: 1.5, color: C.midText, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {convText}
                </pre>
              )}
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.stopPropagation(); return }
                  if (e.key === 'Enter') { e.preventDefault(); sendLine() }
                }}
                placeholder="e.g. make the description shorter, then press Enter"
                style={{ fontFamily: C.mono, fontSize: 12, color: C.nameText, background: C.surfaceHi, border: `1px solid ${C.borderHi}`, borderRadius: 6, padding: '8px 10px', outline: 'none' }}
              />
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
                <button onClick={cancel} disabled={busy}
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
