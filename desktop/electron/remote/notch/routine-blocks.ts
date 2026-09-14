/**
 * ROUTINE CHAT BLOCKS AND NOTCH PAYLOADS.
 *
 * Spec: docs/superpowers/specs/2026-09-14-agent-routines-design.md §5.
 *
 * A routine fires unattended, on its own schedule, as an independent session
 * — never inside the Agent conversation the user is looking at. Its firing
 * and its result still belong in that conversation's chat, though, placed
 * where they happened in time. `routineEntries` turns runs into blocks;
 * `mergeRoutineBlocks` is the pure placement that interleaves them with the
 * Agent's own base blocks (see notch-controller.ts `restoreAgentConversation`
 * for what those look like: an optional leading notice with no `at`, message
 * blocks with `at`, and an optional trailing error with no `at`).
 */

import type { Block } from '../blocks'
import type { RoutineItemView, RoutineRun, RoutinesView, RunStatus } from '../agent/routines/types'

const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const TERMINAL_WITH_RESULT: ReadonlySet<RunStatus> = new Set(['done', 'failed', 'skipped'])

function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** What fired this run, worded for the chip in the chat. */
export function triggerLabel(run: RoutineRun): string {
  const t = run.trigger
  switch (t.type) {
    case 'schedule': return `${hhmm(t.scheduledFor)} schedule`
    case 'manual': return 'Run now'
    case 'event': return 'notes ready'
    case 'approval': return 'approved'
  }
}

/**
 * Runs → chat block entries, newest `limit` of the visible ones.
 *
 * Visible = fired since the conversation's `since` cutoff, or still unread —
 * an unread result must not disappear just because the chat was cleared
 * after it fired. `results` lets the caller hand over the full result text
 * for a run (read from its transcript) in preference to the short preview
 * that is always on the run record.
 */
export function routineEntries(
  runs: readonly RoutineRun[],
  opts: { since: number; limit?: number; results?: ReadonlyMap<string, string> },
): Array<{ at: number; block: Block }> {
  const limit = opts.limit ?? 30
  const visible = runs.filter(r => r.firedAt >= opts.since || r.unread)
  const chronological = [...visible].sort((a, b) => a.firedAt - b.firedAt)
  const trimmed = chronological.length > limit ? chronological.slice(chronological.length - limit) : chronological

  const entries: Array<{ at: number; block: Block }> = []
  for (const run of trimmed) {
    entries.push({
      at: run.firedAt,
      block: {
        kind: 'routineRun', at: run.firedAt, name: run.name, status: run.status,
        trigger: triggerLabel(run), what: run.id,
        ...(run.reason ? { reason: run.reason } : {}),
      },
    })
    // silent runs and cancelled runs never post a result; posted is the
    // record's own memory of whether a routineResult entry already exists.
    if (!run.posted || !TERMINAL_WITH_RESULT.has(run.status)) continue
    const at = run.endedAt ?? run.firedAt
    const status = run.status as 'done' | 'failed' | 'skipped'
    const text = status === 'done' ? (opts.results?.get(run.id) ?? run.resultPreview ?? '') : (run.resultPreview ?? '')
    const proposals = run.proposals && run.proposals.length > 0
      ? run.proposals.map(p => ({ id: p.id, title: p.title, detail: p.detail, state: p.state as string }))
      : undefined
    entries.push({
      at,
      block: {
        kind: 'routineResult', at, startedAt: run.firedAt, name: run.name, status, text,
        what: run.id, path: run.routineId,
        ...(run.reason ? { reason: run.reason } : {}),
        ...(proposals ? { proposals } : {}),
      },
    })
  }
  return entries
}

const isUserMessage = (b: Block): b is Extract<Block, { kind: 'message' }> => b.kind === 'message' && b.role === 'user'
const isAssistantMessage = (b: Block): b is Extract<Block, { kind: 'message' }> => b.kind === 'message' && b.role === 'assistant'
const atOf = (b: Block): number | undefined => 'at' in b ? (b as { at?: number }).at : undefined

/**
 * Interleave routine entries into the Agent's base blocks by time.
 *
 * Placement (spec §5): an entry goes right after the last base block whose
 * `at` is at or before it. Two guards override that raw time slot:
 *
 * - it must never split a user message from the reply that answers it — an
 *   entry landing in that gap moves to just after the reply;
 * - while the Agent is busy with an unanswered last question, an entry that
 *   would land after that question goes before it instead, so the pending
 *   question stays the last thing in the transcript.
 *
 * Blocks without `at` (the leading notice, the trailing error) never move
 * and are never anchors an entry can be placed ahead of — they inherit an
 * effective position (first, last, or their predecessor's) purely so entries
 * sort around them correctly.
 */
export function mergeRoutineBlocks(
  base: readonly Block[],
  entries: ReadonlyArray<{ at: number; block: Block }>,
  opts: { busy: boolean },
): Block[] {
  if (entries.length === 0) return [...base]

  const eff: number[] = new Array(base.length)
  for (let i = 0; i < base.length; i++) {
    const a = atOf(base[i])
    // Order matters when a single block is both first and last (a base array
    // that is nothing but a trailing error): the error must stay last, so
    // that check goes before the leading-notice one.
    if (a !== undefined) eff[i] = a
    else if (i === base.length - 1 && base[i].kind === 'error') eff[i] = Infinity // trailing error: stays last
    else if (i === 0) eff[i] = -Infinity // leading notice: stays first
    else eff[i] = eff[i - 1] // inherits the block before it
  }

  // For every user message, the index of the assistant message that answers
  // it — the first assistant message after it and before the next user
  // message. Absent means the question is still unanswered.
  const replyOf = new Map<number, number>()
  let openUser = -1
  let lastUserIndex = -1
  for (let i = 0; i < base.length; i++) {
    const b = base[i]
    if (isUserMessage(b)) { openUser = i; lastUserIndex = i; continue }
    if (isAssistantMessage(b) && openUser !== -1 && !replyOf.has(openUser)) replyOf.set(openUser, i)
  }
  const lastUserAnswered = lastUserIndex !== -1 && replyOf.has(lastUserIndex)

  const anchorFor = (at: number): number => {
    let anchor = -1
    for (let i = 0; i < base.length; i++) if (eff[i] <= at) anchor = i
    // Never split a user message from its reply.
    let u = -1
    for (let i = 0; i <= anchor; i++) if (isUserMessage(base[i])) u = i
    if (u !== -1) {
      const reply = replyOf.get(u)
      if (reply !== undefined && reply > anchor) anchor = reply
    }
    // Busy: keep an unanswered last question last.
    if (opts.busy && lastUserIndex !== -1 && !lastUserAnswered && anchor >= lastUserIndex) anchor = lastUserIndex - 1
    return anchor
  }

  // Stable-sort by time so callers that hand over entries out of order still
  // interleave correctly, while ties (a run's routineRun/routineResult pair)
  // keep their given order.
  const ordered = [...entries].sort((a, b) => a.at - b.at)
  const buckets = new Map<number, Block[]>()
  for (const e of ordered) {
    const anchor = anchorFor(e.at)
    const bucket = buckets.get(anchor)
    if (bucket) bucket.push(e.block)
    else buckets.set(anchor, [e.block])
  }

  const result: Block[] = []
  for (const b of buckets.get(-1) ?? []) result.push(b)
  for (let i = 0; i < base.length; i++) {
    result.push(base[i])
    for (const b of buckets.get(i) ?? []) result.push(b)
  }
  return result
}

// ─── Notch payloads ────────────────────────────────────────────────────────

export interface RoutineItemP {
  id: string; name: string; scheduleLabel: string; kind: 'read-only' | 'takes-actions'; enabled: boolean
  nextRunLabel: string; lastRunLabel?: string; running: boolean; error?: string
}

export interface RoutineRunDetailP {
  runId: string; routineId: string; name: string; status: string; trigger: string; firedAt: number
  endedAt?: number; windowLabel?: string; totals?: string; provider?: string
  activity: Array<{ at: number; text: string }>; result?: string; error?: string
  canCancel: boolean; hasTranscript: boolean
}

export interface RoutinesP {
  available: boolean; reason?: string; items: RoutineItemP[]; run?: RoutineRunDetailP
}

function lastRunLabel(lastRun: { status: RunStatus; at: number }, now: number): string {
  const d = new Date(lastRun.at), n = new Date(now)
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  const time = hhmm(lastRun.at)
  return `Last run ${sameDay ? time : `${DAY_LABEL[d.getDay()]} ${time}`} · ${lastRun.status}`
}

function routineItemPayload(item: RoutineItemView, now: number): RoutineItemP {
  return {
    id: item.id, name: item.name, scheduleLabel: item.scheduleLabel, kind: item.kind, enabled: item.enabled,
    nextRunLabel: item.nextRunLabel,
    ...(item.lastRun ? { lastRunLabel: lastRunLabel(item.lastRun, now) } : {}),
    running: item.running,
    ...(item.error ? { error: item.error } : {}),
  }
}

function runDetailPayload(run: RoutineRun, result: string | null, hasTranscript: boolean): RoutineRunDetailP {
  const resolvedResult = result ?? run.resultPreview
  return {
    runId: run.id, routineId: run.routineId, name: run.name, status: run.status, trigger: triggerLabel(run),
    firedAt: run.firedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(run.window?.label ? { windowLabel: run.window.label } : {}),
    ...(run.manifestTotals ? { totals: `${run.manifestTotals.sessions} sessions · ${run.manifestTotals.turns} turns` } : {}),
    ...(run.provider ? { provider: run.provider } : {}),
    activity: run.activity,
    ...(resolvedResult !== undefined ? { result: resolvedResult } : {}),
    ...(run.error ? { error: run.error } : {}),
    canCancel: run.status === 'queued' || run.status === 'running',
    hasTranscript,
  }
}

/** The Agent `TaskDetailP.routines` payload — pure, no I/O. */
export function routinesPayload(
  view: RoutinesView | null,
  run?: { run: RoutineRun; result: string | null; hasTranscript: boolean },
  now: number = Date.now(),
): RoutinesP {
  if (view === null) return { available: false, reason: 'Routines are loading', items: [] }
  return {
    available: view.available,
    ...(view.reason ? { reason: view.reason } : {}),
    items: view.items.map(item => routineItemPayload(item, now)),
    ...(run ? { run: runDetailPayload(run.run, run.result, run.hasTranscript) } : {}),
  }
}
