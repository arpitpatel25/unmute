import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suppressionFingerprint, isSuppressed, shortlist, applyMatch } from './curator-match.ts'
import { occurrenceKey, type CandidatesFile } from './curator-store.ts'
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
