// Unmute Orchestrate — the cockpit wall (NEW surface, §3 #3 of the handoff).
//
// A voice-conducted cockpit for many concurrent Claude Code sessions. The human
// stays the conductor; this surface owns the ATTENTION layer — always pointing the
// user at the session that most needs them, at near-zero switch cost.
//
// Visual direction: Ops Console (§7). Two hard rules, enforced here:
//   R1 — color encodes EXACTLY ONE variable: status. Cards are structurally
//        identical (same border/shape/neutral surface). The only color anywhere is
//        the status dot + label. No colored bars, no multi-hue surfaces.
//   R2 — hierarchy comes from CONTRAST, not whitespace: name brightest →
//        needs-you status loudest → dir/elapsed/meta deliberately dimmed.
//
// Data is REAL — driven by the existing useRemoteTasks (one task object, the same
// one the overlay renders). This is the integration, not a parallel store.
//
// FROZEN/UNTOUCHED: dictation core. COEXISTS: the one-offs overlay (rendered as a
// region in the rail here; floats independently when the wall is down).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRemoteTasks, type RemoteTask } from './useRemoteTasks'

// ─── Ops Console palette ─── neutral everywhere; hue lives ONLY in `status`.
const C = {
  bg: '#0d0f12',
  surface: '#15181d',
  surfaceHi: '#191d23',
  border: '#23272e',
  borderHi: '#323843',
  nameText: '#e8eaed', // brightest — session name only
  midText: '#9aa0a8',
  dimText: '#5b616b', // dir/branch/elapsed/meta — pushed toward background
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

function elapsed(fromMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - fromMs) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
}

// The one-line current activity, and (when focused) the line lifted VERBATIM from
// the session — re-entry (§6.5): extraction, NOT an LLM summary.
function activityLine(t: RemoteTask): string {
  return t.question?.text || t.error?.reason || t.step || t.result?.summary || '…'
}

// ─── status dot ───
function Dot({ state }: { state: WallState }) {
  const { color } = statusOf(state)
  const needsYou = state === 'needs-user' || state === 'stuck' || state === 'failed'
  return (
    <span
      style={{
        width: 8, height: 8, borderRadius: 9999, background: color, flex: 'none',
        // "loudest" for needs-you (R2): a soft glow only on the states that pull you.
        boxShadow: needsYou ? `0 0 7px ${color}` : 'none',
      }}
    />
  )
}

// ─── one session card — structurally identical for every state (R1) ───
function Card({
  t, now, queuePos, focused, onClick,
}: {
  t: RemoteTask; now: number; queuePos: number | null; focused: boolean; onClick: () => void
}) {
  const st = statusOf(t.state)
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left', cursor: 'pointer', fontFamily: C.mono,
        background: focused ? C.surfaceHi : C.surface,
        border: `1px solid ${focused ? C.borderHi : C.border}`,
        borderRadius: 8, padding: '11px 13px',
        display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0,
        transition: 'background 120ms ease, border-color 120ms ease',
      }}
    >
      {/* row 1: status (loud) + queue badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Dot state={t.state} />
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, color: st.color, textTransform: 'uppercase' }}>
          {st.label}
        </span>
        {queuePos != null && (
          <span style={{ marginLeft: 'auto', fontSize: 10, color: C.dimText, border: `1px solid ${C.border}`, borderRadius: 4, padding: '1px 5px' }}>
            Q{queuePos}
          </span>
        )}
      </div>

      {/* row 2: NAME — brightest thing on the card (R2) */}
      <div style={{ fontSize: 13.5, fontWeight: 600, color: C.nameText, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {t.intent || t.id.slice(0, 8)}
      </div>

      {/* row 3: one-line current activity — mid */}
      <div style={{ fontSize: 11.5, color: C.midText, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {activityLine(t)}
      </div>

      {/* row 4: meta — deliberately DIMMED toward background (R2) */}
      <div style={{ display: 'flex', gap: 10, fontSize: 10.5, color: C.dimText }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {/* dir/branch disambiguates two sessions on one repo — not exposed on the task yet, placeholder */}
          ~/…/{(t.intent || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 18)}
        </span>
        <span style={{ marginLeft: 'auto', flex: 'none' }}>{elapsed(t.createdAt, now)}</span>
      </div>
    </button>
  )
}

// ─── focused stage: the real terminal + the hoisted pending line (re-entry) ───
function Stage({ t, now, onAnswer, onClose }: { t: RemoteTask; now: number; onAnswer: (text: string) => void; onClose: () => void }) {
  const st = statusOf(t.state)
  const pending = t.question
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: C.mono, minWidth: 0 }}>
      {/* hoisted header — what this session is waiting on, at eye level */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: `1px solid ${C.border}` }}>
        <Dot state={t.state} />
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, color: st.color, textTransform: 'uppercase' }}>{st.label}</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: C.nameText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.intent}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: C.dimText }}>{elapsed(t.createdAt, now)}</span>
        <button onClick={onClose} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.midText, borderRadius: 5, fontSize: 11, padding: '2px 8px', cursor: 'pointer', fontFamily: C.mono }}>esc</button>
      </div>

      {/* the pending line, lifted VERBATIM (extraction, not generation §6.5) */}
      <div style={{ padding: '14px', background: C.surfaceHi, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 14, color: C.nameText, lineHeight: 1.5 }}>{activityLine(t)}</div>
        {pending?.choices?.length ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 11 }}>
            {pending.choices.map((c, i) => (
              <button key={c} onClick={() => onAnswer(c)}
                style={{ fontFamily: C.mono, fontSize: 12, color: C.nameText, background: C.surface, border: `1px solid ${C.borderHi}`, borderRadius: 6, padding: '5px 11px', cursor: 'pointer' }}>
                <span style={{ color: C.dimText, marginRight: 6 }}>{i + 1}</span>{c}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* the REAL terminal sits untouched here (§3, §6.5). Wired next; placeholder for now. */}
      <div style={{ flex: 1, padding: '14px', overflow: 'auto', color: C.midText, fontSize: 12, lineHeight: 1.6 }}>
        <div style={{ color: C.faintText }}>{/* LiveTerminal taskId={t.id} mounts here — real PTY, full fidelity */}— terminal —</div>
      </div>
    </div>
  )
}

// ─── the rail (Queue / One-offs / Skills) ───
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
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(i)
  }, [])

  // queue: everything that needs the user (not 'working'), ordered
  // errored → question → done (§4). Sort key is trivial to change (open, §10).
  const queue = useMemo(
    () => tasks
      .filter((t) => statusOf(t.state).rank < 99)
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

  // esc reverses focus; you ADVANCE the crank, the system never auto-advances (§6.4)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFocusedId(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const stepIn = useCallback(() => { if (top) setFocusedId(top.id) }, [top])

  return (
    <div style={{ position: 'absolute', inset: 0, background: C.bg, color: C.midText, fontFamily: C.mono, display: 'flex', flexDirection: 'column' }}>
      {/* tap banner — highest-priority queued item, always at the top (§8) */}
      {top && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', borderBottom: `1px solid ${C.border}`, background: C.surface }}>
          <Dot state={top.state} />
          <span style={{ fontSize: 12.5, color: C.nameText, fontWeight: 600 }}>{top.intent}</span>
          <span style={{ fontSize: 12, color: C.midText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>— {activityLine(top)}</span>
          <button onClick={stepIn}
            style={{ marginLeft: 'auto', flex: 'none', fontFamily: C.mono, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: C.bg, background: statusOf(top.state).color, border: 'none', borderRadius: 5, padding: '4px 11px', cursor: 'pointer' }}>
            STEP IN ▸
          </button>
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* main: grid of cards (resting) OR the focused stage */}
        <div style={{ flex: 1, minWidth: 0, padding: 14, overflow: 'auto' }}>
          {focused ? (
            <Stage t={focused} now={now} onAnswer={(text) => { answer(focused.id, text); setFocusedId(null) }} onClose={() => setFocusedId(null)} />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(248px, 1fr))', gap: 11, alignContent: 'start' }}>
              {tasks.length === 0 && (
                <div style={{ color: C.dimText, fontSize: 12, padding: 8 }}>no sessions — speak to spawn one</div>
              )}
              {tasks.map((t) => (
                <Card key={t.id} t={t} now={now} queuePos={queuePos.get(t.id) ?? null} focused={false} onClick={() => setFocusedId(t.id)} />
              ))}
            </div>
          )}
        </div>

        {/* right rail */}
        <div style={{ width: 230, flex: 'none', borderLeft: `1px solid ${C.border}`, padding: 14, display: 'flex', flexDirection: 'column', gap: 18, overflow: 'auto' }}>
          <RailSection title={`Queue · ${queue.length}`}>
            {queue.length === 0 && <div style={{ fontSize: 11, color: C.faintText }}>clear</div>}
            {queue.map((t, i) => (
              <button key={t.id} onClick={() => setFocusedId(t.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '3px 0', fontFamily: C.mono }}>
                <span style={{ fontSize: 10, color: C.dimText, width: 16 }}>Q{i + 1}</span>
                <Dot state={t.state} />
                <span style={{ fontSize: 11.5, color: C.midText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.intent}</span>
              </button>
            ))}
          </RailSection>

          {/* one-offs region — the existing overlay, absorbed when the wall is up (§3 #2) */}
          <RailSection title="One-offs">
            <div style={{ fontSize: 11, color: C.faintText }}>short-lived tasks resolve here</div>
          </RailSection>

          {/* skills — glanceable list of the user's frequent skills (§8) */}
          <RailSection title="Skills">
            <div style={{ fontSize: 11, color: C.faintText }}>—</div>
          </RailSection>
        </div>
      </div>
    </div>
  )
}
