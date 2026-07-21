// Unmute Remote — the Skill Curator's on-disk store (single owner).
//
// Everything the curator persists lives under ~/.unmute/remote/curator/ and
// every byte of it flows through this module: the sweep cursor (how far each
// session transcript has been read), the candidate patterns, the ownership
// record (the authority on which skills the curator created — one compact entry
// per owned skill, current state only), rejections, user feedback, and the
// proposal directories awaiting a decision.
//
// Two invariants, copied from skill-usage.ts (the meta.json lesson):
//   1. Every mutation runs on a module-level serialized write-chain — two
//      near-simultaneous writers never interleave a read-modify-write.
//   2. Every file write is atomic: write `<file>.tmp`, then rename. A reader
//      never sees a torn file.
//
// All paths are injectable (curatorPaths(baseDir)) so tests run in tmp dirs.

import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export interface CuratorPaths { root: string; cursor: string; candidates: string; ownership: string; rejections: string; feedback: string; proposalsDir: string; tracesDir: string; logsDir: string }

export function curatorPaths(baseDir?: string): CuratorPaths {
  const root = baseDir ?? join(homedir(), '.unmute', 'remote', 'curator')
  return {
    root,
    cursor: join(root, 'cursor.json'),
    candidates: join(root, 'candidates.json'),
    ownership: join(root, 'ownership.json'),
    rejections: join(root, 'rejections.json'),
    feedback: join(root, 'feedback.json'),
    proposalsDir: join(root, 'proposals'),
    tracesDir: join(root, 'traces'),
    // DEV-ONLY diagnostics sink (curator-devlog.ts). Never created unless the
    // dev-log gate is on — an unpackaged dev run, or an explicit env export.
    logsDir: join(root, 'logs'),
  }
}

export interface SessionCursor { transcriptPath: string; lineOffset: number; lastSweptAt: number; sweeps: number }
export interface CursorFile { version: 1; lastSweepAt: number; sessions: Record<string, SessionCursor> }

export interface CandidateOccurrence { taskId: string; sweepId: string; count: number; at: string; tracePointer: string; errors?: number; recoveries?: number; wallClockMs?: number }

// Pattern Ledger lifecycle status. A candidate starts 'watched' (implicit —
// legacy/undefined status defaults here via entryStatus()) and can progress
// through graduation/surfacing/acceptance into a live skill, or be rejected
// or retired.
export type EntryStatus =
  | 'watched' | 'graduated' | 'surfaced' | 'accepted' | 'live' | 'rejected' | 'retired'

// Splits a candidate's distilled content into the parts that stay constant
// across every occurrence (the skill body) vs. the parts that vary per run
// (candidates to become template slots).
export interface VarianceMap {
  constant: string[]   // parts stable across every occurrence (skill body)
  varying: string[]    // parts that change per run (become slots)
}

// One observation of whether a fresh occurrence agrees with or diverges from
// the ledger entry's established pattern.
export interface DivergenceObservation {
  sessionId: string
  at: string
  verdict: 'agree' | 'diverge'
  note: string
}

export interface Candidate {
  key: string; title: string; skeleton: string; total: number; struggle: boolean; firstSeen: string; lastSeen: string; occurrences: CandidateOccurrence[]
  // --- Enrichment (all optional — existing candidates.json entries have none of these) ---
  status?: EntryStatus
  variance?: VarianceMap
  priorScore?: number
  priorRationale?: string
  linkedSkillId?: string
  divergenceLog?: DivergenceObservation[]
  // User-side anchor (spec §0 A/B). A suspicion carries the actionable INTENT it
  // watches and the reusable CONTEXT the user supplied for it; on a strict
  // confirmation (applyMatch fold) the supplied context accumulates by union.
  intent?: string
  contextSupplied?: string[]
  // The user-side struggle signal (spec §0 D): a time the user had to CORRECT the
  // model ("no, do it this way"). Shapes HOW the graduated skill should read — it
  // is NEVER a graduation reason. Optional: populated by the suspicion-entry fold
  // (Task 4); the judge (Task 6) only renders it when present.
  correction?: string
}
export interface CandidatesFile { version: 1; candidates: Record<string, Candidate> }

/** Lifecycle status of a ledger entry, defaulting legacy/undefined entries to 'watched'. */
export function entryStatus(c: Candidate): EntryStatus { return c.status ?? 'watched' }

/** True iff this entry is a SUSPICION — on the watch-list, not yet graduated to a
 *  skill (spec §0 C). A newly-created entry is always a suspicion; graduation to
 *  a live skill is the periodic judge's job (Task 6), never automatic here. */
export function isSuspicion(c: Candidate): boolean { return entryStatus(c) === 'watched' }

/** PURE: return a new CandidatesFile with candidate `key`'s status (and, when
 *  supplied, linkedSkillId) updated. Never mutates `file`. A key that is absent
 *  from the ledger is a no-op — the same file shape is returned unchanged. This
 *  is how a proposal's lifecycle (surfaced → live / rejected) is written back to
 *  the pattern the proposal was drawn from. No IO — persistence goes through
 *  writeCandidates. */
export function setCandidateStatus(file: CandidatesFile, key: string, status: EntryStatus, patch?: Partial<Pick<Candidate, 'linkedSkillId'>>): CandidatesFile {
  const existing = file.candidates[key]
  if (!existing) return file // absent key — nothing to transition
  const updated: Candidate = { ...existing, status }
  if (patch && patch.linkedSkillId !== undefined) updated.linkedSkillId = patch.linkedSkillId
  return { version: 1, candidates: { ...file.candidates, [key]: updated } }
}

/** Number of distinct sessions (taskIds) that have produced an occurrence of this candidate. */
export function distinctSessionCount(c: Candidate): number {
  return new Set(c.occurrences.map(o => o.taskId)).size
}

/** PURE: drop watch-list suspicions that never earned a real confirmation within
 *  `windowDays` (default 30) — spec §0 constraint C (decay). One-offs (even
 *  context-rich ones) must quietly expire so the watch-list stays small and
 *  unbiased. Drops an entry iff ALL of: it is a suspicion (entryStatus ===
 *  'watched'), it is UNCONFIRMED (distinctSessionCount < 2), and it is STALE
 *  (lastSeen older than nowMs - windowDays*86400_000). Keeps everything else:
 *  confirmed suspicions (>=2 distinct sessions — on track to graduate), any
 *  non-'watched' status (graduated/surfaced/accepted/live/rejected/retired),
 *  anything carrying a linkedSkillId, and any recent watched entry. A bad or
 *  missing `lastSeen` (unparseable) is treated as NOT stale — never drop on a
 *  parse error. Never mutates `file`; mirrors pruneTraces / applyMatch's
 *  immutable-return style. No IO — persistence goes through writeCandidates. */
export function pruneSuspicions(file: CandidatesFile, nowMs: number, windowDays = 30): CandidatesFile {
  const cutoff = nowMs - windowDays * 86400_000
  const candidates: Record<string, Candidate> = {}
  for (const [key, c] of Object.entries(file.candidates)) {
    const parsed = Date.parse(c.lastSeen)
    const stale = !Number.isNaN(parsed) && parsed < cutoff
    const drop = isSuspicion(c) && !c.linkedSkillId && distinctSessionCount(c) < 2 && stale
    if (!drop) candidates[key] = c
  }
  return { version: 1, candidates }
}

export interface SkillOwnership { origin: 'unmute'; contentHash: string; createdAt: string; updatedAt: string; userModified?: boolean }
export interface OwnershipFile { version: 1; skills: Record<string, SkillOwnership> }

export interface ProposalDraft { name: string; description: string; body: string }
export interface ProposalEvidence { occurrences: number; sessions: Array<{ id: string; intent: string; at: string; tracePointer: string }>; firstSeen: string; lastSeen: string; struggle: { errors: number; recoveries: number; wallClockMin: number } }
// Gardening verbs (Task 6): create graduates a new candidate; narrow/split/merge
// rewrite an existing owned skill's body (the update-family); retire removes
// one. 'update' is retired from this union — a persisted proposal with the old
// kind is mapped to 'narrow' at the readProposal load boundary (see below) so
// every caller only ever sees the new union.
export interface Proposal { id: string; sweepId: string; proposedAt: string; kind: 'create' | 'narrow' | 'split' | 'merge' | 'retire'; draft: ProposalDraft; evidence: ProposalEvidence; rationale: string; changeSummary?: string[]; targetSkill?: string; diff?: string; triggeringEvidence?: string[]; affectedSessions?: Array<{ id: string; invokedAt: string }>; sourceKeys?: string[]; resolution: null | { action: 'accepted' | 'rejected'; at: string; userEdited: boolean; reason?: string } }

export interface FeedbackEntry { at: string; skill: string; note: string; consumedBySweep?: string }

// ---------------------------------------------------------------------------
// Serialized write-chain + atomic JSON IO (the two invariants).

let chain: Promise<unknown> = Promise.resolve()
/** Run `fn` on the module-level serialized write-chain: two near-simultaneous
 *  callers never interleave a read-modify-write. Exported so other writers
 *  (e.g. curator-writer's collision-guard-through-write critical section) can
 *  share the SAME chain — do NOT nest serialized() inside serialized(), that
 *  self-deadlocks; use the *Core helpers for work already inside the lock. */
export function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn)
  chain = p.catch(() => { /* keep the chain alive */ })
  return p
}

async function readJson<T>(file: string, empty: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return empty
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2))
  await fs.rename(tmp, file) // atomic — a reader never sees a torn file
}

// ---------------------------------------------------------------------------
// Cursor

const emptyCursor = (): CursorFile => ({ version: 1, lastSweepAt: 0, sessions: {} })

export async function readCursor(p: CuratorPaths): Promise<CursorFile> {
  const raw = await readJson<CursorFile>(p.cursor, emptyCursor())
  if (raw && raw.version === 1 && raw.sessions) return raw
  return emptyCursor()
}

export async function writeCursor(p: CuratorPaths, f: CursorFile): Promise<void> {
  return serialized(() => writeJsonAtomic(p.cursor, f))
}

// ---------------------------------------------------------------------------
// Candidates

const emptyCandidates = (): CandidatesFile => ({ version: 1, candidates: {} })

export async function readCandidates(p: CuratorPaths): Promise<CandidatesFile> {
  const raw = await readJson<CandidatesFile>(p.candidates, emptyCandidates())
  if (raw && raw.version === 1 && raw.candidates) return raw
  return emptyCandidates()
}

export async function writeCandidates(p: CuratorPaths, f: CandidatesFile): Promise<void> {
  return serialized(() => writeJsonAtomic(p.candidates, f))
}

// ---------------------------------------------------------------------------
// Accumulator merge (§4.6) — cross-sweep occurrence memory. Repetition is
// ledger arithmetic: a candidate's `total` is the SUM of its occurrence counts
// across every sweep that ever saw it. This is the only reason repetition
// detection works across days — Monday's sighting is remembered so Thursday's
// makes two. Merge is idempotent per (key, taskId, sweepId): a retried sweep
// re-submitting the same distill report never double-counts.

/** A distilled finding from one work session, read USER-SIDE (spec §0 A/B/D/G):
 *  the user's turns are the index, and each finding is one actionable INTENT the
 *  user expressed plus the reusable CONTEXT they supplied for it (the payload a
 *  future skill would bake in). `correction` is the user-side struggle signal —
 *  a time the user had to correct the model ("no, do it this way") — a bonus, not
 *  a gate. `bodySketch` sketches how it was actually done, read only where the
 *  user pointed. The primary fields are intent / contextSupplied / correction /
 *  bodySketch; `title` / `skeleton` / `count` / `struggle` are kept populated
 *  (title = intent, skeleton = bodySketch, struggle = !!correction) for downstream
 *  compatibility while later tasks re-aim the consumers.
 *
 *  The MODIFICATION signal (agree/diverge on an existing skill) is no longer a
 *  distill field: it moved to its own focused skill-usage-audit pass (AuditResult,
 *  spec §0 E). Distill only extracts new-work findings. */
export interface DistillProcedure {
  intent: string
  contextSupplied: string[]
  correction?: string
  bodySketch: string
  // Compatibility fields (populated from the primary fields for downstream consumers).
  title: string
  skeleton: string
  count: number
  struggle: boolean
  usedCuratedSkill?: { name: string; friction: string }
}

/** One skill-usage AUDIT verdict (spec §0 E, Cadence A mode 2): for a skill that
 *  was INVOKED in a session, did it FINISH the user's job or leave them at some
 *  stage to hand-drive the rest? Produced by the focused audit pass, not distill.
 *   - `ok`     = it did the job.
 *   - `extend` = it got the user partway; the skill needs more.
 *   - `wrong`  = it did the wrong thing / the user rejected its output. */
export interface AuditResult {
  skill: string
  verdict: 'ok' | 'extend' | 'wrong'
  note: string
}

/** Stable slug from a procedure title: lowercase, non-alphanumeric runs → '-',
 *  collapsed, trimmed of leading/trailing '-', capped at 60 chars. Two titles
 *  that name the same procedure must map to the same key. */
export function occurrenceKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '') // re-trim in case the slice landed mid-separator
}

/** Merge distill reports into the candidates ledger. PURE: returns a new
 *  CandidatesFile, never mutates `file` (the pipeline may retry with the same
 *  input object). No IO — persistence goes through writeCandidates. */
export function mergeDistill(file: CandidatesFile, procs: DistillProcedure[], ctx: { taskId: string; sweepId: string; at: string; tracePointer: string }): CandidatesFile {
  const candidates: Record<string, Candidate> = {}
  for (const [k, c] of Object.entries(file.candidates)) {
    candidates[k] = { ...c, occurrences: c.occurrences.slice() }
  }
  for (const proc of procs) {
    const key = occurrenceKey(proc.title)
    const existing = candidates[key]
    // title/skeleton are fixed at first sighting and kept thereafter.
    const cand: Candidate = existing
      ? { ...existing, occurrences: existing.occurrences.slice() }
      : { key, title: proc.title, skeleton: proc.skeleton, total: 0, struggle: false, firstSeen: ctx.at, lastSeen: ctx.at, occurrences: [] }
    // Idempotency: skip if this (taskId, sweepId) already contributed an occurrence.
    if (cand.occurrences.some(o => o.taskId === ctx.taskId && o.sweepId === ctx.sweepId)) {
      candidates[key] = cand
      continue
    }
    cand.occurrences.push({ taskId: ctx.taskId, sweepId: ctx.sweepId, count: proc.count, at: ctx.at, tracePointer: ctx.tracePointer })
    cand.total = cand.occurrences.reduce((s, o) => s + o.count, 0)
    cand.struggle = cand.struggle || proc.struggle
    cand.firstSeen = cand.occurrences.reduce((m, o) => (o.at < m ? o.at : m), cand.firstSeen)
    cand.lastSeen = cand.occurrences.reduce((m, o) => (o.at > m ? o.at : m), cand.lastSeen)
    candidates[key] = cand
  }
  return { version: 1, candidates }
}

// ---------------------------------------------------------------------------
// Ownership — the D10/D17 authority on which skills the curator owns. A COMPACT
// record: one entry per owned skill holding CURRENT state only (origin, current
// content-hash, created/last-updated timestamps, an optional user-modified
// flag). Bounded by the number of owned skills — never an append-only event log.

const emptyOwnership = (): OwnershipFile => ({ version: 1, skills: {} })

export async function readOwnership(p: CuratorPaths): Promise<OwnershipFile> {
  const raw = await readJson<OwnershipFile>(p.ownership, emptyOwnership())
  if (raw && raw.version === 1 && raw.skills) return raw
  return emptyOwnership() // tolerate a missing file or an old-format ledger
}

/** Names with a materialized skill on disk per the ownership record. Retirement
 *  removes the entry (removeOwnership), so this set shrinks when a skill is
 *  retired. */
export function ownedSkillNames(o: OwnershipFile): Set<string> {
  return new Set(Object.keys(o.skills))
}

/** Remove an owned skill's ownership entry (retirement). LOCK-FREE — only call
 *  from code already inside a serialized() section (nesting the lock self-
 *  deadlocks). A name we do not own is a no-op. Standalone callers must use
 *  removeOwnership. */
export async function removeOwnershipCore(p: CuratorPaths, name: string): Promise<void> {
  const f = await readOwnership(p)
  if (!f.skills[name]) return // not owned — nothing to remove
  delete f.skills[name]
  await writeJsonAtomic(p.ownership, f)
}

export async function removeOwnership(p: CuratorPaths, name: string): Promise<void> {
  return serialized(() => removeOwnershipCore(p, name))
}

/** Upsert an ownership entry WITHOUT taking the serialization lock. Creates the
 *  entry if absent (createdAt = updatedAt = at), else advances updatedAt = at;
 *  ALWAYS sets contentHash and clears userModified (a fresh curator write
 *  supersedes any prior hand-edit flag). Only call from code already running
 *  inside a serialized() critical section (nesting the lock self-deadlocks).
 *  Standalone callers must use recordOwnership. */
export async function recordOwnershipCore(p: CuratorPaths, name: string, contentHash: string, at: string): Promise<void> {
  const f = await readOwnership(p)
  const existing = f.skills[name]
  f.skills[name] = existing
    ? { ...existing, origin: 'unmute', contentHash, updatedAt: at, userModified: false }
    : { origin: 'unmute', contentHash, createdAt: at, updatedAt: at, userModified: false }
  await writeJsonAtomic(p.ownership, f)
}

export async function recordOwnership(p: CuratorPaths, name: string, contentHash: string, at: string): Promise<void> {
  return serialized(() => recordOwnershipCore(p, name, contentHash, at))
}

/** Mark an owned skill as user-modified and adopt the current on-disk hash.
 *  LOCK-FREE — only call from code already inside a serialized() section.
 *  Idempotent: if the stored hash already equals currentHash it is a no-op and
 *  returns false. Returns true iff it changed something. A name we do not own is
 *  a no-op (nothing to flag). */
export async function markUserModifiedCore(p: CuratorPaths, name: string, currentHash: string): Promise<boolean> {
  const f = await readOwnership(p)
  const existing = f.skills[name]
  if (!existing) return false // not owned — nothing to flag
  if (existing.contentHash === currentHash) return false // already at this hash — idempotent
  f.skills[name] = { ...existing, contentHash: currentHash, userModified: true }
  await writeJsonAtomic(p.ownership, f)
  return true
}

export async function markUserModified(p: CuratorPaths, name: string, currentHash: string): Promise<boolean> {
  return serialized(() => markUserModifiedCore(p, name, currentHash))
}

// ---------------------------------------------------------------------------
// Rejections

export async function readRejections(p: CuratorPaths): Promise<Array<{ at: string; name: string; reason?: string }>> {
  const raw = await readJson<Array<{ at: string; name: string; reason?: string }>>(p.rejections, [])
  return Array.isArray(raw) ? raw : []
}

export async function appendRejection(p: CuratorPaths, r: { at: string; name: string; reason?: string }): Promise<void> {
  return serialized(async () => {
    const all = await readRejections(p)
    all.push(r)
    await writeJsonAtomic(p.rejections, all)
  })
}

// ---------------------------------------------------------------------------
// Feedback

export async function readFeedback(p: CuratorPaths): Promise<FeedbackEntry[]> {
  const raw = await readJson<FeedbackEntry[]>(p.feedback, [])
  return Array.isArray(raw) ? raw : []
}

export async function appendFeedback(p: CuratorPaths, f: FeedbackEntry): Promise<void> {
  return serialized(async () => {
    const all = await readFeedback(p)
    all.push(f)
    await writeJsonAtomic(p.feedback, all)
  })
}

/** Stamp every not-yet-consumed feedback entry as consumed by this sweep. */
export async function markFeedbackConsumed(p: CuratorPaths, sweepId: string): Promise<void> {
  return serialized(async () => {
    const all = await readFeedback(p)
    let changed = false
    for (const e of all) {
      if (!e.consumedBySweep) {
        e.consumedBySweep = sweepId
        changed = true
      }
    }
    if (changed) await writeJsonAtomic(p.feedback, all)
  })
}

// ---------------------------------------------------------------------------
// Proposals — each lives in its own DIRECTORY (proposals/<id>/proposal.json)
// so draft.md and the review conversation can live beside the JSON.

const proposalFile = (p: CuratorPaths, id: string): string => join(p.proposalsDir, id, 'proposal.json')

export async function writeProposal(p: CuratorPaths, prop: Proposal): Promise<void> {
  return serialized(() => writeJsonAtomic(proposalFile(p, prop.id), prop))
}

/** Load boundary for a persisted Proposal: maps the retired `kind:'update'`
 *  (proposals written before the create/narrow/split/merge/retire rename) to
 *  its successor `'narrow'`, so every caller past this point only ever sees
 *  the new union. Read as an untyped record first — a stale on-disk `'update'`
 *  is not a valid `Proposal['kind']`, so trusting the `Proposal` type here
 *  would hide the very value this function exists to normalize. */
export async function readProposal(p: CuratorPaths, id: string): Promise<Proposal | null> {
  const raw = await readJson<(Record<string, unknown> & { kind?: unknown }) | null>(proposalFile(p, id), null)
  if (!raw) return null
  if (raw.kind === 'update') raw.kind = 'narrow'
  return raw as unknown as Proposal
}

export async function listPendingProposals(p: CuratorPaths): Promise<Proposal[]> {
  let ids: string[]
  try {
    ids = await fs.readdir(p.proposalsDir)
  } catch {
    return [] // no proposals dir yet
  }
  const pending: Proposal[] = []
  for (const id of ids) {
    const prop = await readProposal(p, id)
    if (prop && prop.resolution === null) pending.push(prop)
  }
  return pending.sort((a, b) => (a.proposedAt < b.proposedAt ? 1 : a.proposedAt > b.proposedAt ? -1 : 0))
}

export async function resolveProposal(p: CuratorPaths, id: string, res: NonNullable<Proposal['resolution']>): Promise<void> {
  return serialized(async () => {
    const prop = await readJson<Proposal | null>(proposalFile(p, id), null)
    if (!prop) return // nothing to resolve
    prop.resolution = res
    await writeJsonAtomic(proposalFile(p, id), prop)
  })
}

// ---------------------------------------------------------------------------
// Transcript deltas — read only what's new since the cursor, plus a small
// lookback window for context. Read-only: transcripts belong to Claude Code.

export async function readTranscriptDelta(transcriptPath: string, fromLine: number, lookbackLines?: number): Promise<{ lines: string[]; lookback: string[]; newOffset: number }> {
  let raw: string
  try {
    raw = await fs.readFile(transcriptPath, 'utf8')
  } catch {
    return { lines: [], lookback: [], newOffset: fromLine }
  }
  const all = raw.split('\n')
  while (all.length && all[all.length - 1] === '') all.pop() // drop trailing empties
  const lines = all.slice(fromLine)
  const lookback = all.slice(Math.max(0, fromLine - (lookbackLines ?? 200)), fromLine)
  return { lines, lookback, newOffset: all.length }
}

// ---------------------------------------------------------------------------
// Trace retention — raw session traces live on a short rolling window (the
// blessed retention default, Global Constraint 12): distilled patterns in
// candidates.json persist forever, but the raw traces under tracesDir/
// (filenames shaped `<taskId>-<sweepId>.txt`, see curator.ts's traceFile) are
// pruned after `keepDays`. Best-effort and defensive by design: a missing
// tracesDir or a per-file stat/unlink failure must never throw or break a
// sweep — this is housekeeping, not a correctness path. Only trace files are
// touched; candidates.json and everything else under root is untouched.

/** Delete trace files under `p.tracesDir` whose mtime is older than
 *  `nowMs - keepDays*86400_000` (default keepDays = 14). Returns the
 *  filenames pruned. Best-effort: a missing tracesDir yields `[]`; a
 *  per-file stat/unlink error is swallowed and that file is skipped. */
export async function pruneTraces(p: CuratorPaths, nowMs: number, keepDays = 14): Promise<string[]> {
  const cutoff = nowMs - keepDays * 86400_000
  let names: string[]
  try {
    names = await fs.readdir(p.tracesDir)
  } catch {
    return [] // no traces dir yet — nothing to prune
  }
  const pruned: string[] = []
  for (const name of names) {
    try {
      const file = join(p.tracesDir, name)
      const st = await fs.stat(file)
      if (st.mtimeMs < cutoff) {
        await fs.unlink(file)
        pruned.push(name)
      }
    } catch {
      // Best-effort: a stat/unlink race or permission error skips this file,
      // never aborts the sweep.
    }
  }
  return pruned
}
