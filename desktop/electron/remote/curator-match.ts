// Unmute Remote — the Skill Curator's matcher: pure helpers for retrieval
// pre-filter, apply-match merge, and suppression fingerprinting.
//
// This file starts with suppression only (Task 2). Retrieval/apply-match
// helpers land in a later task — see docs/superpowers/plans/
// 2026-07-20-skill-curator-revamp.md (Task 4).
//
// Suppression (Constraint 8 — "Reject → suppress (never re-surface)"):
// rejections are keyed by skill NAME (see curator-store's readRejections /
// appendRejection), so the suppression check is name-anchored — a name that
// was rejected once never resurfaces regardless of how its signature reads
// on a later sweep.

import { createHash } from 'node:crypto'
import { occurrenceKey, type Candidate, type CandidatesFile, type DistillProcedure, type VarianceMap } from './curator-store'
import type { MatchDecision } from './curator-prompts'

/** sha256 hex of `${draftName} ${norm}`, where `norm` is `signature`
 *  lowercased, whitespace collapsed to single spaces, and trimmed. Mirrors
 *  curator-writer.ts's contentHash (sha256 hex via node:crypto). */
export function suppressionFingerprint(draftName: string, signature: string): string {
  const norm = signature.toLowerCase().replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(`${draftName} ${norm}`, 'utf8').digest('hex')
}

/** Name-anchored suppression check: true iff some prior rejection was keyed
 *  by this exact skill name. Rejections in this system are keyed by skill
 *  name, so that's the suppression key — a rejected name never re-surfaces. */
export function isSuppressed(name: string, rejections: Array<{ at: string; name: string; reason?: string }>): boolean {
  return rejections.some(r => r.name === name)
}

// ---------------------------------------------------------------------------
// Retrieval shortlist + apply-match merge (Task 4).
//
// The matcher (Task 3's buildMatchPrompt) needs a per-sweep, per-procedure
// shortlist of ledger entries to judge against — showing it the WHOLE ledger
// would be unbounded prompt size. `shortlist` is a cheap, no-LLM token-overlap
// ranking so the matcher only sees plausibly-related entries. `applyMatch`
// folds one matcher verdict into the ledger, mirroring mergeDistill's
// occurrence-append idempotency + `total = Σ occurrence counts` exactly, plus
// variance bookkeeping (constant vs. per-run-varying slots).

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'onto', 'over',
  'under', 'then', 'than', 'when', 'what', 'how', 'are', 'was', 'were', 'has',
  'have', 'had', 'not', 'but', 'you', 'your', 'its', 'it', 'to', 'of', 'in',
  'on', 'at', 'by', 'an', 'as', 'is', 'be', 'or', 'via', 'a', 'do', 'does',
])

/** lowercase, split on non-alphanumerics, drop stopwords and very short (≤2
 *  char) tokens, return the unique set. */
function tokenize(s: string): Set<string> {
  const out = new Set<string>()
  for (const t of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length > 2 && !STOPWORDS.has(t)) out.add(t)
  }
  return out
}

/** A shortlist entry, carrying the shared-unique-token `score` that ranked it.
 *  score 0 = zero-overlap padding (no shared tokens) — the combined-shortlist
 *  union in the sweep drops these so genuine matches are never crowded past the
 *  cap by another proc's padding. `intent`/`contextSupplied` are PROJECTED off
 *  the ledger candidate (spec §0 A/B) so the matcher can compare the user-side
 *  fields on BOTH sides — a legacy entry that predates them simply omits them. */
export interface ShortlistEntry { key: string; title: string; skeleton: string; score: number; intent?: string; contextSupplied?: string[] }

/** Cheap, no-LLM ranking so the matcher only sees plausibly-related ledger
 *  entries: score every existing candidate by shared-unique-token count
 *  against `proc`'s title+skeleton, return the top `limit` (default 12). Each
 *  entry carries its `score` (0 = zero-overlap padding) so a caller unioning
 *  many procs' shortlists can rank by real overlap and drop the padding. */
export function shortlist(
  file: CandidatesFile,
  proc: DistillProcedure,
  limit = 12,
): ShortlistEntry[] {
  const queryTokens = tokenize(`${proc.title} ${proc.skeleton}`)
  const scored: ShortlistEntry[] = Object.values(file.candidates).map((c) => {
    const candTokens = tokenize(`${c.title} ${c.skeleton}`)
    let shared = 0
    for (const t of queryTokens) if (candTokens.has(t)) shared++
    const entry: ShortlistEntry = { key: c.key, title: c.title, skeleton: c.skeleton, score: shared }
    // Project the user-side fields (spec §0 A/B) so the matcher weighs intent +
    // context on the ledger side too. Omit them for a legacy entry that has none.
    if (c.intent && c.intent.trim() !== '') entry.intent = c.intent
    if (c.contextSupplied && c.contextSupplied.length) entry.contextSupplied = c.contextSupplied
    return entry
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/** Fold `arr`'s unique elements into `varying`, deduping, without mutating
 *  either input. */
function foldVarying(variance: VarianceMap | undefined, additions: string[]): VarianceMap {
  const v: VarianceMap = variance
    ? { constant: variance.constant.slice(), varying: variance.varying.slice() }
    : { constant: [], varying: [] }
  for (const a of additions) {
    if (!v.varying.includes(a)) v.varying.push(a)
  }
  return v
}

/** Union new supplied-context items into an entry's accumulated `contextSupplied`,
 *  deduping, without mutating the input. Returns undefined only when there is
 *  nothing to carry (neither existing nor new items) so a bare entry stays bare. */
function foldContext(existing: string[] | undefined, additions: string[]): string[] | undefined {
  const merged = existing ? existing.slice() : []
  for (const a of additions) {
    if (a.trim() !== '' && !merged.includes(a)) merged.push(a)
  }
  return merged.length ? merged : undefined
}

/** PURE, no-IO. Fold one matched (or new) procedure into the ledger; returns a
 *  NEW CandidatesFile (never mutates `file` — mirrors mergeDistill). Occurrence
 *  append is IDEMPOTENT per (key, taskId, sweepId): a retried sweep re-applying
 *  the same decision never double-counts `total` or the variance list. */
export function applyMatch(
  file: CandidatesFile,
  proc: DistillProcedure,
  decision: MatchDecision,
  ctx: { taskId: string; sweepId: string; at: string; tracePointer: string; errors?: number; recoveries?: number; wallClockMs?: number },
): CandidatesFile {
  const candidates: Record<string, Candidate> = {}
  for (const [k, c] of Object.entries(file.candidates)) {
    candidates[k] = { ...c, occurrences: c.occurrences.slice() }
  }
  const variedThisRun = decision.variedThisRun ?? []
  const matchedKey = decision.matchedKey && candidates[decision.matchedKey] ? decision.matchedKey : null

  if (matchedKey) {
    let cand = candidates[matchedKey]
    cand = { ...cand, occurrences: cand.occurrences.slice() }
    // Idempotency: skip if this (taskId, sweepId) already contributed an occurrence.
    if (cand.occurrences.some((o) => o.taskId === ctx.taskId && o.sweepId === ctx.sweepId)) {
      candidates[matchedKey] = cand
      return { version: 1, candidates }
    }
    cand.occurrences.push({ taskId: ctx.taskId, sweepId: ctx.sweepId, count: proc.count, at: ctx.at, tracePointer: ctx.tracePointer, errors: ctx.errors, recoveries: ctx.recoveries, wallClockMs: ctx.wallClockMs })
    cand.total = cand.occurrences.reduce((s, o) => s + o.count, 0)
    cand.struggle = cand.struggle || proc.struggle
    cand.firstSeen = cand.occurrences.reduce((m, o) => (o.at < m ? o.at : m), cand.firstSeen)
    cand.lastSeen = cand.occurrences.reduce((m, o) => (o.at > m ? o.at : m), cand.lastSeen)
    cand.variance = foldVarying(cand.variance, variedThisRun)
    // Strict confirmation earned: fold the confirming finding's supplied context
    // into the suspicion (spec §0 C — a genuine same-intent recurrence enriches it).
    const foldedCtx = foldContext(cand.contextSupplied, proc.contextSupplied ?? [])
    if (foldedCtx) cand.contextSupplied = foldedCtx
    candidates[matchedKey] = cand
    return { version: 1, candidates }
  }

  // matchedKey null or unknown — new (or re-discovered-under-the-same-key) entry.
  // A newly created entry is a SUSPICION (status:'watched') carrying the user-side
  // fields (intent + contextSupplied). Graduation to a skill is the judge's job.
  const key = occurrenceKey(proc.title)
  const existing = candidates[key]
  const cand: Candidate = existing
    ? { ...existing, occurrences: existing.occurrences.slice() }
    : {
        key,
        title: proc.title,
        skeleton: proc.skeleton,
        total: 0,
        struggle: false,
        firstSeen: ctx.at,
        lastSeen: ctx.at,
        occurrences: [],
        status: 'watched',
        variance: { constant: [], varying: [] },
        intent: proc.intent && proc.intent.trim() !== '' ? proc.intent : proc.title,
      }
  // Idempotency: skip if this (taskId, sweepId) already contributed an occurrence.
  if (cand.occurrences.some((o) => o.taskId === ctx.taskId && o.sweepId === ctx.sweepId)) {
    candidates[key] = cand
    return { version: 1, candidates }
  }
  cand.occurrences.push({ taskId: ctx.taskId, sweepId: ctx.sweepId, count: proc.count, at: ctx.at, tracePointer: ctx.tracePointer, errors: ctx.errors, recoveries: ctx.recoveries, wallClockMs: ctx.wallClockMs })
  cand.total = cand.occurrences.reduce((s, o) => s + o.count, 0)
  cand.struggle = cand.struggle || proc.struggle
  cand.firstSeen = cand.occurrences.reduce((m, o) => (o.at < m ? o.at : m), cand.firstSeen)
  cand.lastSeen = cand.occurrences.reduce((m, o) => (o.at > m ? o.at : m), cand.lastSeen)
  if (!cand.status) cand.status = 'watched'
  cand.variance = foldVarying(cand.variance, variedThisRun)
  const foldedCtx = foldContext(cand.contextSupplied, proc.contextSupplied ?? [])
  if (foldedCtx) cand.contextSupplied = foldedCtx
  candidates[key] = cand
  return { version: 1, candidates }
}

// ---------------------------------------------------------------------------
// Divergence accumulation (Task 10, Constraint 7 — "a SINGLE divergence never
// modifies a skill").
//
// The skill-usage AUDIT pass (spec §0 E) emits a per-skill verdict whenever a
// session INVOKED one of the user's skills. The sweep RECORDS those verdicts as
// observations onto the ledger entry that OWNS the skill (the one whose
// linkedSkillId names it) via recordSkillObservation, then a deterministic FLOOR
// gate (hasAccumulatedDivergence) decides whether a modification proposal is even
// eligible. "Same-direction" refinement is the judge's job; this floor only
// prevents a single event from reshaping a skill.

/** PURE, no-IO. Append `obs` as a DivergenceObservation to the ledger entry
 *  whose `linkedSkillId === obs.skill`; returns a NEW CandidatesFile (never
 *  mutates `file`, mirroring applyMatch). Creates the `divergenceLog` array if
 *  absent. NO-OP (returns `file` unchanged, same reference) when no entry links
 *  that skill — an observation about a skill this curator doesn't own on the
 *  ledger has nowhere to accumulate. */
export function recordSkillObservation(
  file: CandidatesFile,
  obs: { skill: string; verdict: 'agree' | 'diverge'; note: string },
  ctx: { sessionId: string; at: string },
): CandidatesFile {
  const entry = Object.entries(file.candidates).find(([, c]) => c.linkedSkillId === obs.skill)
  if (!entry) return file // no ledger entry owns this skill — nothing to accumulate
  const [key, cand] = entry
  const divergenceLog = (cand.divergenceLog ?? []).slice()
  divergenceLog.push({ sessionId: ctx.sessionId, at: ctx.at, verdict: obs.verdict, note: obs.note })
  return { version: 1, candidates: { ...file.candidates, [key]: { ...cand, divergenceLog } } }
}

/** PURE. Deterministic anti-thrash floor: true iff `entry.divergenceLog` holds
 *  ≥ 2 observations with verdict 'diverge'. A single divergence may be
 *  legitimate per-run variation, so it is NOT enough to reshape a skill; the
 *  "same-direction" refinement is left to the judge. */
export function hasAccumulatedDivergence(entry: Candidate): boolean {
  return (entry.divergenceLog ?? []).filter((d) => d.verdict === 'diverge').length >= 2
}
