import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suppressionFingerprint, isSuppressed, shortlist, applyMatch, recordSkillObservation, hasAccumulatedDivergence } from './curator-match.ts'
import { occurrenceKey, isSuspicion, type Candidate, type CandidatesFile } from './curator-store.ts'
import type { MatchDecision } from './curator-prompts.ts'

test('suppressionFingerprint is stable across identical inputs', () => {
  const a = suppressionFingerprint('file-taxes', 'quarterly tax filing flow')
  const b = suppressionFingerprint('file-taxes', 'quarterly tax filing flow')
  assert.equal(a, b)
})

test('suppressionFingerprint normalizes signature (case + whitespace) before hashing', () => {
  const a = suppressionFingerprint('file-taxes', 'Quarterly   Tax\nFiling Flow')
  const b = suppressionFingerprint('file-taxes', 'quarterly tax filing flow')
  assert.equal(a, b)
})

test('suppressionFingerprint differs across draft names for the same signature', () => {
  const a = suppressionFingerprint('file-taxes', 'sig')
  const b = suppressionFingerprint('other-name', 'sig')
  assert.notEqual(a, b)
})

test('isSuppressed matches a prior rejection by name', () => {
  assert.equal(isSuppressed('file-taxes', [{ at: 'x', name: 'file-taxes' }]), true)
})

test('isSuppressed is false for an unrelated name', () => {
  assert.equal(isSuppressed('file-taxes', [{ at: 'x', name: 'pr-review' }]), false)
})

test('isSuppressed is false against an empty rejection list', () => {
  assert.equal(isSuppressed('file-taxes', []), false)
})

// --- Task 4: retrieval shortlist ---

test('shortlist ranks candidates by shared-token overlap and returns the top `limit`', () => {
  const file: CandidatesFile = {
    version: 1,
    candidates: {
      'edit-talking-head-video': {
        key: 'edit-talking-head-video', title: 'editing a talking-head video', skeleton: 'trim silence, crop to vertical, add captions',
        total: 3, struggle: true, firstSeen: 'a', lastSeen: 'a', occurrences: [],
      },
      'extract-invoice': {
        key: 'extract-invoice', title: 'extracting invoice line items', skeleton: 'parse pdf, pull vendor and totals',
        total: 3, struggle: true, firstSeen: 'a', lastSeen: 'a', occurrences: [],
      },
      'unrelated-thing': {
        key: 'unrelated-thing', title: 'completely different topic', skeleton: 'nothing in common at all here',
        total: 1, struggle: false, firstSeen: 'a', lastSeen: 'a', occurrences: [],
      },
    },
  }
  const proc = { title: 'editing a talking head video', skeleton: 'trim silence and crop vertical', count: 1, struggle: true }
  const top = shortlist(file, proc, 2)
  assert.equal(top.length, 2)
  assert.equal(top[0].key, 'edit-talking-head-video')
})

test('shortlist EXPOSES a shared-token score — real matches score >0, zero-overlap padding scores 0 (M5)', () => {
  // The combined-shortlist union in the sweep relies on this score to drop
  // zero-overlap padding so a real match is never crowded past the cap.
  const file: CandidatesFile = {
    version: 1,
    candidates: {
      'real-match': {
        key: 'real-match', title: 'editing a talking-head video', skeleton: 'trim silence crop vertical add captions',
        total: 3, struggle: true, firstSeen: 'a', lastSeen: 'a', occurrences: [],
      },
      'zero-overlap': {
        key: 'zero-overlap', title: 'quarterly bookkeeping reconciliation', skeleton: 'reconcile ledgers against statements',
        total: 1, struggle: false, firstSeen: 'a', lastSeen: 'a', occurrences: [],
      },
    },
  }
  const proc = { title: 'edit a talking head video', skeleton: 'trim silence and crop vertical', count: 1, struggle: true }
  const top = shortlist(file, proc, 12)
  const real = top.find((e) => e.key === 'real-match')
  const zero = top.find((e) => e.key === 'zero-overlap')
  assert.ok(real && real.score > 0)       // genuine token overlap
  assert.equal(zero?.score, 0)            // padding — no shared tokens
})

test('shortlist PROJECTS the user-side intent + contextSupplied off the ledger candidate (symmetric matching, Task 4 follow-up)', () => {
  const file: CandidatesFile = {
    version: 1,
    candidates: {
      'extract-invoice': {
        key: 'extract-invoice', title: 'extracting invoice line items', skeleton: 'parse pdf',
        total: 3, struggle: true, firstSeen: 'a', lastSeen: 'a', occurrences: [],
        intent: 'extract invoice totals', contextSupplied: ['vendor field', 'totals in USD'],
      },
      'bare': {
        key: 'bare', title: 'a bare legacy entry', skeleton: 'invoice pdf', total: 1, struggle: false,
        firstSeen: 'a', lastSeen: 'a', occurrences: [],
      },
    },
  }
  const proc = { title: 'extract invoice totals', skeleton: 'parse the pdf invoice', count: 1, struggle: false }
  const top = shortlist(file, proc, 12)
  const enriched = top.find((e) => e.key === 'extract-invoice')
  assert.equal(enriched?.intent, 'extract invoice totals')
  assert.deepEqual(enriched?.contextSupplied, ['vendor field', 'totals in USD'])
  const bare = top.find((e) => e.key === 'bare')
  assert.equal(bare?.intent, undefined)               // a legacy entry projects nothing extra
  assert.equal(bare?.contextSupplied, undefined)
})

test('shortlist returns all entries when the ledger is smaller than the limit', () => {
  const file: CandidatesFile = {
    version: 1,
    candidates: {
      a: { key: 'a', title: 'foo', skeleton: 'bar', total: 1, struggle: false, firstSeen: 'a', lastSeen: 'a', occurrences: [] },
    },
  }
  const proc = { title: 'zzz unrelated', skeleton: 'nothing', count: 1, struggle: false }
  assert.equal(shortlist(file, proc, 12).length, 1)
})

// --- Task 4: apply-match merge ---

const ctx1 = { taskId: 't1', sweepId: 'sw1', at: '2026-07-14', tracePointer: 'traces/a' }
const ctx2 = { taskId: 't2', sweepId: 'sw2', at: '2026-07-17', tracePointer: 'traces/b' }

test('applyMatch appends an occurrence to the matched entry, growing total and folding variedThisRun into variance.varying', () => {
  const empty: CandidatesFile = { version: 1, candidates: {} }
  const key = occurrenceKey('editing a talking-head video')
  const seeded: CandidatesFile = {
    version: 1,
    candidates: {
      [key]: {
        key, title: 'editing a talking-head video', skeleton: 'trim, crop, caption',
        total: 2, struggle: true, firstSeen: '2026-07-10', lastSeen: '2026-07-10',
        occurrences: [{ taskId: 't0', sweepId: 'sw0', count: 2, at: '2026-07-10', tracePointer: 'traces/z' }],
      },
    },
  }
  const proc = { title: 'edit a talking head video for a client', skeleton: 'trim, crop, caption', count: 3, struggle: true }
  const decision: MatchDecision = { procedureIndex: 0, matchedKey: key, confidence: 0.9, variedThisRun: ['client name'] }

  const out = applyMatch(seeded, proc, decision, ctx2)
  const cand = out.candidates[key]
  assert.equal(cand.total, 5) // 2 + 3
  assert.equal(cand.occurrences.length, 2)
  assert.equal(cand.firstSeen, '2026-07-10')
  assert.equal(cand.lastSeen, '2026-07-17')
  assert.deepEqual(cand.variance?.varying, ['client name'])
  // input untouched (pure)
  assert.equal(seeded.candidates[key].total, 2)
  void empty
})

test('applyMatch creates a new watched entry when matchedKey is null', () => {
  const empty: CandidatesFile = { version: 1, candidates: {} }
  const proc = { title: 'Set up a vendor MCP connector', skeleton: 'register app, exchange keys, verify handshake', count: 1, struggle: true }
  const decision: MatchDecision = { procedureIndex: 0, matchedKey: null, confidence: 0, variedThisRun: ['vendor name'] }

  const out = applyMatch(empty, proc, decision, ctx1)
  const key = occurrenceKey(proc.title)
  const cand = out.candidates[key]
  assert.ok(cand)
  assert.equal(cand.status, 'watched')
  assert.equal(cand.total, 1)
  assert.equal(cand.title, proc.title)
  assert.equal(cand.skeleton, proc.skeleton)
  assert.deepEqual(cand.variance, { constant: [], varying: ['vendor name'] })
})

test('applyMatch is idempotent per (matchedKey, taskId, sweepId) — a retry does not double-count total', () => {
  const key = occurrenceKey('editing a talking-head video')
  const seeded: CandidatesFile = {
    version: 1,
    candidates: {
      [key]: {
        key, title: 'editing a talking-head video', skeleton: 'trim, crop, caption',
        total: 2, struggle: true, firstSeen: '2026-07-10', lastSeen: '2026-07-10',
        occurrences: [{ taskId: 't0', sweepId: 'sw0', count: 2, at: '2026-07-10', tracePointer: 'traces/z' }],
      },
    },
  }
  const proc = { title: 'edit a talking head video', skeleton: 'trim, crop, caption', count: 3, struggle: true }
  const decision: MatchDecision = { procedureIndex: 0, matchedKey: key, confidence: 0.9, variedThisRun: ['client name'] }

  const once = applyMatch(seeded, proc, decision, ctx2)
  const twice = applyMatch(once, proc, decision, ctx2) // exact retry — same taskId/sweepId

  assert.equal(twice.candidates[key].total, 5) // unchanged from `once`
  assert.equal(twice.candidates[key].occurrences.length, 2)
})

test('applyMatch treats an unknown matchedKey (not on the ledger) as a new entry, not a crash', () => {
  const empty: CandidatesFile = { version: 1, candidates: {} }
  const proc = { title: 'Some new procedure', skeleton: 'does a thing', count: 1, struggle: false }
  const decision: MatchDecision = { procedureIndex: 0, matchedKey: 'not-a-real-key', confidence: 0.5, variedThisRun: [] }
  const out = applyMatch(empty, proc, decision, ctx1)
  const key = occurrenceKey(proc.title)
  assert.ok(out.candidates[key])
  assert.equal(out.candidates['not-a-real-key'], undefined)
})

// --- Task 4: strict confirmation + suspicion entry ---

test('a new finding creates a status:watched SUSPICION carrying intent + contextSupplied', () => {
  const empty: CandidatesFile = { version: 1, candidates: {} }
  const proc = {
    intent: 'set up a vendor MCP connector', contextSupplied: ['register the app', 'exchange keys'],
    bodySketch: 'register, exchange, verify', title: 'set up a vendor MCP connector', skeleton: 'register, exchange, verify',
    count: 1, struggle: false,
  }
  const out = applyMatch(empty, proc, { procedureIndex: 0, matchedKey: null, confidence: 0, variedThisRun: [] }, ctx1)
  const cand = out.candidates[occurrenceKey(proc.title)]
  assert.equal(cand.status, 'watched')
  assert.ok(isSuspicion(cand))
  assert.equal(cand.intent, 'set up a vendor MCP connector')
  assert.deepEqual(cand.contextSupplied, ['register the app', 'exchange keys'])
})

test('two findings with the SAME intent + overlapping context CONFIRM into one entry (2 occurrences), context unions', () => {
  const empty: CandidatesFile = { version: 1, candidates: {} }
  const first = {
    intent: 'extract invoice totals', contextSupplied: ['vendor field', 'totals in USD'],
    bodySketch: 'parse pdf', title: 'extract invoice totals', skeleton: 'parse pdf', count: 1, struggle: false,
  }
  const s1 = applyMatch(empty, first, { procedureIndex: 0, matchedKey: null, confidence: 0, variedThisRun: [] }, ctx1)
  const key = occurrenceKey(first.title)

  // Strict LLM matcher confirmed this is the SAME intent (matchedKey = key); the
  // per-run specific ("march") is recorded as a slot, and its new context folds in.
  const second = {
    intent: 'extract invoice totals for march', contextSupplied: ['vendor field', 'tax line'],
    bodySketch: 'parse pdf', title: 'extract invoice totals for march', skeleton: 'parse pdf', count: 1, struggle: false,
  }
  const s2 = applyMatch(s1, second, { procedureIndex: 0, matchedKey: key, confidence: 0.95, variedThisRun: ['march'] }, ctx2)

  assert.equal(Object.keys(s2.candidates).length, 1)              // fused — one entry
  assert.equal(s2.candidates[key].occurrences.length, 2)         // two occurrences
  assert.equal(s2.candidates[key].total, 2)
  assert.deepEqual(s2.candidates[key].variance?.varying, ['march'])
  assert.deepEqual(s2.candidates[key].contextSupplied, ['vendor field', 'totals in USD', 'tax line']) // unioned
})

test('two topically-similar but DIFFERENT-intent findings do NOT fuse — two separate watched suspicions', () => {
  const empty: CandidatesFile = { version: 1, candidates: {} }
  const edit = {
    intent: 'edit a talking-head video', contextSupplied: ['crop to vertical'],
    bodySketch: 'trim, crop, caption', title: 'edit a talking-head video', skeleton: 'trim, crop, caption', count: 1, struggle: false,
  }
  const record = {
    intent: 'record a talking-head video', contextSupplied: ['use the webcam'],
    bodySketch: 'set up camera, record', title: 'record a talking-head video', skeleton: 'set up camera, record', count: 1, struggle: false,
  }
  // The strict matcher returns matchedKey:null for the second (different intent,
  // only surface similarity) — the loose "same topic" fuse is exactly what must NOT happen.
  const a = applyMatch(empty, edit, { procedureIndex: 0, matchedKey: null, confidence: 0, variedThisRun: [] }, ctx1)
  const b = applyMatch(a, record, { procedureIndex: 0, matchedKey: null, confidence: 0, variedThisRun: [] }, ctx2)

  assert.equal(Object.keys(b.candidates).length, 2)              // stayed two distinct patterns
  for (const c of Object.values(b.candidates)) {
    assert.equal(c.status, 'watched')
    assert.ok(isSuspicion(c))
    assert.equal(c.occurrences.length, 1)
  }
})

// --- Wiring gap: propagate proc.correction onto the ledger entry (reaches the judge) ---

test('a new finding WITH a correction creates a candidate carrying that correction', () => {
  const empty: CandidatesFile = { version: 1, candidates: {} }
  const proc = {
    intent: 'set up a vendor MCP connector', contextSupplied: ['register the app'],
    correction: 'no, use the desktop app not the CLI',
    bodySketch: 'register, exchange, verify', title: 'set up a vendor MCP connector', skeleton: 'register, exchange, verify',
    count: 1, struggle: true,
  }
  const out = applyMatch(empty, proc, { procedureIndex: 0, matchedKey: null, confidence: 0, variedThisRun: [] }, ctx1)
  const cand = out.candidates[occurrenceKey(proc.title)]
  assert.equal(cand.correction, 'no, use the desktop app not the CLI')
})

test('folding a later finding WITH a correction into a matched entry sets/updates the entry\'s correction', () => {
  const key = occurrenceKey('editing a talking-head video')
  const seeded: CandidatesFile = {
    version: 1,
    candidates: {
      [key]: {
        key, title: 'editing a talking-head video', skeleton: 'trim, crop, caption',
        total: 2, struggle: true, firstSeen: '2026-07-10', lastSeen: '2026-07-10',
        occurrences: [{ taskId: 't0', sweepId: 'sw0', count: 2, at: '2026-07-10', tracePointer: 'traces/z' }],
      },
    },
  }
  const proc = {
    intent: 'edit a talking head video', contextSupplied: [],
    correction: 'no, crop to vertical not square',
    bodySketch: 'trim, crop, caption', title: 'edit a talking head video', skeleton: 'trim, crop, caption', count: 3, struggle: true,
  }
  const decision: MatchDecision = { procedureIndex: 0, matchedKey: key, confidence: 0.9, variedThisRun: [] }
  const out = applyMatch(seeded, proc, decision, ctx2)
  assert.equal(out.candidates[key].correction, 'no, crop to vertical not square')
})

test('a fold with NO correction does NOT clobber an existing one', () => {
  const key = occurrenceKey('editing a talking-head video')
  const seeded: CandidatesFile = {
    version: 1,
    candidates: {
      [key]: {
        key, title: 'editing a talking-head video', skeleton: 'trim, crop, caption',
        total: 2, struggle: true, firstSeen: '2026-07-10', lastSeen: '2026-07-10',
        occurrences: [{ taskId: 't0', sweepId: 'sw0', count: 2, at: '2026-07-10', tracePointer: 'traces/z' }],
        correction: 'no, crop to vertical not square',
      },
    },
  }
  const proc = { title: 'edit a talking head video', skeleton: 'trim, crop, caption', count: 3, struggle: false }
  const decision: MatchDecision = { procedureIndex: 0, matchedKey: key, confidence: 0.9, variedThisRun: [] }
  const out = applyMatch(seeded, proc, decision, ctx2)
  assert.equal(out.candidates[key].correction, 'no, crop to vertical not square')
})

// --- Task 13: per-occurrence struggle metrics ---

test('applyMatch writes errors/recoveries/wallClockMs onto a NEW-entry occurrence', () => {
  const empty: CandidatesFile = { version: 1, candidates: {} }
  const proc = { title: 'Struggled through a thing', skeleton: 'S', count: 1, struggle: true }
  const decision: MatchDecision = { procedureIndex: 0, matchedKey: null, confidence: 0, variedThisRun: [] }
  const out = applyMatch(empty, proc, decision, { ...ctx1, errors: 3, recoveries: 2, wallClockMs: 600_000 })
  const occ = out.candidates[occurrenceKey(proc.title)].occurrences[0]
  assert.equal(occ.errors, 3)
  assert.equal(occ.recoveries, 2)
  assert.equal(occ.wallClockMs, 600_000)
})

test('applyMatch writes errors/recoveries/wallClockMs onto a MATCHED-entry occurrence', () => {
  const key = occurrenceKey('editing a talking-head video')
  const seeded: CandidatesFile = {
    version: 1,
    candidates: {
      [key]: {
        key, title: 'editing a talking-head video', skeleton: 'trim, crop, caption',
        total: 2, struggle: true, firstSeen: '2026-07-10', lastSeen: '2026-07-10',
        occurrences: [{ taskId: 't0', sweepId: 'sw0', count: 2, at: '2026-07-10', tracePointer: 'traces/z' }],
      },
    },
  }
  const proc = { title: 'edit a talking head video', skeleton: 'trim, crop, caption', count: 3, struggle: true }
  const decision: MatchDecision = { procedureIndex: 0, matchedKey: key, confidence: 0.9, variedThisRun: [] }
  const out = applyMatch(seeded, proc, decision, { ...ctx2, errors: 5, recoveries: 4, wallClockMs: 900_000 })
  const occ = out.candidates[key].occurrences[1]
  assert.equal(occ.errors, 5)
  assert.equal(occ.recoveries, 4)
  assert.equal(occ.wallClockMs, 900_000)
})

// --- Task 10: divergence accumulation ---

const linkedEntry = (over: Partial<Candidate> = {}): Candidate => ({
  key: 'pr-review-key', title: 'review a PR', skeleton: 'S', total: 3, struggle: true,
  firstSeen: '2026-07-10', lastSeen: '2026-07-14', occurrences: [], linkedSkillId: 'pr-review',
  ...over,
})

test('recordSkillObservation appends to the entry linked to that skill and returns a NEW file (pure)', () => {
  const file: CandidatesFile = { version: 1, candidates: { 'pr-review-key': linkedEntry() } }
  const out = recordSkillObservation(
    file,
    { skill: 'pr-review', verdict: 'diverge', note: 'skipped the lockfile check' },
    { sessionId: 't7', at: '2026-07-20' },
  )
  const log = out.candidates['pr-review-key'].divergenceLog
  assert.equal(log?.length, 1)
  assert.deepEqual(log?.[0], { sessionId: 't7', at: '2026-07-20', verdict: 'diverge', note: 'skipped the lockfile check' })
  // input untouched (pure)
  assert.equal(file.candidates['pr-review-key'].divergenceLog, undefined)
})

test('recordSkillObservation appends to an existing divergenceLog (creates array only when absent)', () => {
  const seeded = linkedEntry({ divergenceLog: [{ sessionId: 't1', at: '2026-07-11', verdict: 'diverge', note: 'first' }] })
  const file: CandidatesFile = { version: 1, candidates: { 'pr-review-key': seeded } }
  const out = recordSkillObservation(
    file,
    { skill: 'pr-review', verdict: 'agree', note: 'matched this time' },
    { sessionId: 't2', at: '2026-07-20' },
  )
  const log = out.candidates['pr-review-key'].divergenceLog
  assert.equal(log?.length, 2)
  assert.deepEqual(log?.[1], { sessionId: 't2', at: '2026-07-20', verdict: 'agree', note: 'matched this time' })
})

test('recordSkillObservation is a no-op when no entry links that skill', () => {
  const file: CandidatesFile = { version: 1, candidates: { 'pr-review-key': linkedEntry() } }
  const out = recordSkillObservation(
    file,
    { skill: 'some-other-skill', verdict: 'diverge', note: 'n' },
    { sessionId: 't2', at: '2026-07-20' },
  )
  assert.equal(out, file)   // unchanged (same reference)
  assert.equal(out.candidates['pr-review-key'].divergenceLog, undefined)
})

test('hasAccumulatedDivergence: false for 0 or 1 diverge, true for ≥2 (agree observations do not count)', () => {
  assert.equal(hasAccumulatedDivergence(linkedEntry()), false)                                            // no log
  assert.equal(hasAccumulatedDivergence(linkedEntry({ divergenceLog: [] })), false)                       // empty
  assert.equal(hasAccumulatedDivergence(linkedEntry({ divergenceLog: [
    { sessionId: 'a', at: 'x', verdict: 'diverge', note: 'n' },
  ] })), false)                                                                                            // 1 diverge
  assert.equal(hasAccumulatedDivergence(linkedEntry({ divergenceLog: [
    { sessionId: 'a', at: 'x', verdict: 'diverge', note: 'n' },
    { sessionId: 'b', at: 'y', verdict: 'agree', note: 'n' },
  ] })), false)                                                                                            // 1 diverge + 1 agree
  assert.equal(hasAccumulatedDivergence(linkedEntry({ divergenceLog: [
    { sessionId: 'a', at: 'x', verdict: 'diverge', note: 'n' },
    { sessionId: 'b', at: 'y', verdict: 'diverge', note: 'n' },
  ] })), true)                                                                                             // 2 diverge
})
