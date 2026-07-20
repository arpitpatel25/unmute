import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDistillPrompt, parseDistillOutput, parseDistillReasoning, buildSynthesizePrompt, parseSynthesizeOutput, parseSynthesizeReasoning, buildMatchPrompt, parseMatchOutput } from './curator-prompts.ts'

test('distill prompt: points at trace file, demands JSON at outPath, forbids facts/preferences + app-navigation, makes struggle the key signal', () => {
  const p = buildDistillPrompt({ taskId: 't1', intent: 'edit video', tracePath: '/tr/a.txt', outPath: '/out/distill.json', curatedNames: ['pr-review'] })
  assert.ok(p.includes('/tr/a.txt'))
  assert.ok(p.includes('/out/distill.json'))
  assert.ok(/fact|preference/i.test(p))                           // V4 — bare facts/preferences out of scope
  assert.ok(/struggle/i.test(p) && /MOST IMPORTANT|PRIMARY|key/i.test(p)) // V1 — struggle is the key signal
  assert.ok(/app-navigation|click-path|reach-a-state/i.test(p))   // V4 — app-navigation excluded
  assert.ok(p.includes('pr-review'))                              // curated names for friction spotting
})

test('parseDistillOutput: tolerates junk, validates entries', () => {
  assert.deepEqual(parseDistillOutput(null), [])
  assert.deepEqual(parseDistillOutput('not json'), [])
  const ok = parseDistillOutput(JSON.stringify({ procedures: [
    { title: 'T', skeleton: 'S', count: 2, struggle: true },
    { title: '', skeleton: 'S', count: 1, struggle: false },      // dropped: no title
  ] }))
  assert.equal(ok.length, 1)
  assert.equal(ok[0].count, 2)
})

test('synthesize prompt: v2 three tests, disciplines-not-skills exclusion, group-by-domain, task-noun naming, negatives-first examples, changeSummary + full body, restraint', () => {
  const p = buildSynthesizePrompt({
    sweepId: 'sw1',
    candidates: [{ key: 'k', title: 'T', skeleton: 'S', total: 3, struggle: true, firstSeen: 'a', lastSeen: 'b', occurrences: [] }],
    curatedIndex: [{ name: 'pr-review', description: 'd', body: '## Goal\nreview' }],
    rejections: [{ name: 'noise-skill', reason: 'too niche' }],
    feedback: [{ skill: 'pr-review', note: 'misses lockfiles' }],
    outPath: '/out/synth.json',
  })
  // V5 — the three tests (GAP / TASK / REUSE)
  assert.ok(/GAP/.test(p) && /TASK/.test(p) && /REUSE/.test(p))
  assert.ok(/three tests/i.test(p) && /ALL must hold/i.test(p))
  // V4 — cross-cutting disciplines are NOT skills, and app-navigation excluded
  assert.ok(/DISCIPLINE/i.test(p) && /verify a change before saving|applies to ALL work/i.test(p))
  assert.ok(/app-navigation|click-through-an-app|reach-a-state/i.test(p))
  // V6 — negatives-first contrastive examples (NO before YES)
  assert.ok(/Contrastive examples/i.test(p))
  assert.ok(p.includes('→ NO') && p.includes('→ YES'))
  // V3 — group by domain, no slivers
  assert.ok(/GROUP BY DOMAIN/i.test(p) && /ONE skill/i.test(p))
  // V7 — concrete task/domain noun naming, not abstract coined phrases
  assert.ok(/task\/domain noun|kebab-case/i.test(p) && /NEVER an\s*\n?\s*abstract coined phrase|abstract coined phrase/i.test(p))
  // struggle is the primary selection signal (V1)
  assert.ok(/struggle/i.test(p) && /PRIMARY/i.test(p))
  assert.ok(/when unsure, DON'T/i.test(p))                        // restraint posture stays
  assert.ok(/changeSummary/.test(p))                             // D20 plain-language summary
  assert.ok(/full[^\n]*body|complete[^\n]*body/i.test(p))        // update emits full body
  assert.ok(!/unified diff of the body/i.test(p))                // no hand-written diff
  assert.ok(p.includes('seen 3x') || p.includes('total: 3'))
  assert.ok(p.includes('too niche'))
  assert.ok(p.includes('misses lockfiles'))
})

test('parseSynthesizeOutput: validates, stamps ids/resolution, drops invalid', () => {
  assert.deepEqual(parseSynthesizeOutput(null, 'sw1', () => 1), [])
  const out = parseSynthesizeOutput(JSON.stringify({ proposals: [
    { kind: 'create', draft: { name: 'video-load-premiere', description: 'd', body: 'b' },
      evidence: { occurrences: 3, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 2, recoveries: 1, wallClockMin: 40 } },
      rationale: 'why' },
    { kind: 'create', draft: { name: '', description: 'd', body: 'b' }, evidence: null, rationale: '' },  // dropped
  ] }), 'sw1', () => 1700000)
  assert.equal(out.length, 1)
  assert.equal(out[0].sweepId, 'sw1')
  assert.equal(out[0].proposedAt, new Date(1700000).toISOString())
  assert.equal(out[0].resolution, null)
  assert.ok(out[0].id.startsWith('prop_'))
})

test('parseSynthesizeOutput: changeSummary is string[], missing→[], invalid entries dropped', () => {
  const out = parseSynthesizeOutput(JSON.stringify({ proposals: [
    { kind: 'create', draft: { name: 'a-skill', description: 'd', body: 'b' },
      evidence: { occurrences: 1, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 0, recoveries: 0, wallClockMin: 1 } },
      rationale: 'why', changeSummary: ['does X', '', 42, 'why suggested'] },   // '' and 42 dropped
    { kind: 'create', draft: { name: 'b-skill', description: 'd', body: 'b' },
      evidence: { occurrences: 1, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 0, recoveries: 0, wallClockMin: 1 } },
      rationale: 'why' },                                                       // no changeSummary → []
    { kind: 'create', draft: { name: 'c-skill', description: 'd', body: 'b' },
      evidence: { occurrences: 1, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 0, recoveries: 0, wallClockMin: 1 } },
      rationale: 'why', changeSummary: 'not an array' },                        // invalid → []
  ] }), 'sw1', () => 1)
  assert.equal(out.length, 3)
  assert.deepEqual(out[0].changeSummary, ['does X', 'why suggested'])
  assert.deepEqual(out[1].changeSummary, [])
  assert.deepEqual(out[2].changeSummary, [])
})

test('devMode (DEV-ONLY): reasoning ask is present only when devMode=true — prod pays zero extra tokens', () => {
  const dArgs = { taskId: 't1', intent: 'edit video', tracePath: '/tr/a.txt', outPath: '/out/distill.json', curatedNames: ['pr-review'] }
  assert.ok(!/reasoning/i.test(buildDistillPrompt(dArgs)))                    // default (undefined) → no ask
  assert.ok(!/reasoning/i.test(buildDistillPrompt({ ...dArgs, devMode: false })))
  const dDev = buildDistillPrompt({ ...dArgs, devMode: true })
  assert.ok(/reasoning/i.test(dDev))                                         // devMode adds the ask
  assert.ok(/exclude|excluded/i.test(dDev) && /developer diagnostics/i.test(dDev))

  const sArgs = {
    sweepId: 'sw1',
    candidates: [{ key: 'k', title: 'T', skeleton: 'S', total: 3, struggle: true, firstSeen: 'a', lastSeen: 'b', occurrences: [] }],
    curatedIndex: [{ name: 'pr-review', description: 'd', body: '## Goal\nreview' }],
    rejections: [], feedback: [], outPath: '/out/synth.json',
  }
  assert.ok(!/reasoning/i.test(buildSynthesizePrompt(sArgs)))                 // default → no ask
  assert.ok(!/reasoning/i.test(buildSynthesizePrompt({ ...sArgs, devMode: false })))
  const sDev = buildSynthesizePrompt({ ...sArgs, devMode: true })
  assert.ok(/reasoning/i.test(sDev))
  assert.ok(/developer diagnostics/i.test(sDev))
})

test('parse*Reasoning (DEV-ONLY): captures a top-level reasoning field when present; undefined otherwise', () => {
  assert.equal(parseDistillReasoning(null), undefined)
  assert.equal(parseDistillReasoning('not json'), undefined)
  assert.equal(parseDistillReasoning(JSON.stringify({ procedures: [] })), undefined)   // absent
  assert.equal(parseDistillReasoning(JSON.stringify({ procedures: [], reasoning: '   ' })), undefined) // blank → undefined
  assert.equal(parseDistillReasoning(JSON.stringify({ procedures: [], reasoning: 'excluded X because navigation' })), 'excluded X because navigation')
  // The main parser is unaffected by a reasoning field (decision path unchanged).
  assert.equal(parseDistillOutput(JSON.stringify({ procedures: [{ title: 'T', skeleton: 'S', count: 1, struggle: false }], reasoning: 'r' })).length, 1)

  assert.equal(parseSynthesizeReasoning(JSON.stringify({ proposals: [] })), undefined)
  assert.equal(parseSynthesizeReasoning(JSON.stringify({ proposals: [], reasoning: 'considered all candidates' })), 'considered all candidates')
})

test('parseSynthesizeOutput: a synth-provided diff field is IGNORED (D19 — only the sweep sets diff)', () => {
  const out = parseSynthesizeOutput(JSON.stringify({ proposals: [
    { kind: 'narrow', draft: { name: 'a-skill', description: 'd', body: 'new body' },
      evidence: { occurrences: 1, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 0, recoveries: 0, wallClockMin: 1 } },
      rationale: 'why', targetSkill: 'a-skill', diff: '--- fabricated\n+++ fiction\n+not real' },
  ] }), 'sw1', () => 1)
  assert.equal(out.length, 1)
  assert.equal(out[0].diff, undefined)   // the LLM's diff is dropped; only the deterministic sweep sets it
})

// ── Typed proposal kinds (create/narrow/split/merge/retire) ────────────────

const evidence = { occurrences: 1, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 0, recoveries: 0, wallClockMin: 1 } }

test('parseSynthesizeOutput: a raw "update" kind from the model is dropped (model is retrained to emit the new kinds; legacy mapping is a read-boundary concern only)', () => {
  const out = parseSynthesizeOutput(JSON.stringify({ proposals: [
    { kind: 'update', draft: { name: 'a-skill', description: 'd', body: 'b' }, evidence, rationale: 'why', targetSkill: 'a-skill' },
  ] }), 'sw1', () => 1)
  assert.equal(out.length, 0)
})

test('parseSynthesizeOutput: an unrecognized kind is dropped', () => {
  const out = parseSynthesizeOutput(JSON.stringify({ proposals: [
    { kind: 'bogus', draft: { name: 'a-skill', description: 'd', body: 'b' }, evidence, rationale: 'why', targetSkill: 'a-skill' },
  ] }), 'sw1', () => 1)
  assert.equal(out.length, 0)
})

test('parseSynthesizeOutput: create is unchanged — requires valid name/description/body, no targetSkill needed', () => {
  const out = parseSynthesizeOutput(JSON.stringify({ proposals: [
    { kind: 'create', draft: { name: 'video-load-premiere', description: 'd', body: 'b' }, evidence, rationale: 'why' },
  ] }), 'sw1', () => 1)
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'create')
  assert.equal(out[0].draft.name, 'video-load-premiere')
})

for (const kind of ['narrow', 'split', 'merge'] as const) {
  test(`parseSynthesizeOutput: ${kind} requires targetSkill + a draft with non-empty body — dropped without targetSkill`, () => {
    const withoutTarget = parseSynthesizeOutput(JSON.stringify({ proposals: [
      { kind, draft: { name: 'a-skill', description: 'd', body: 'full new body' }, evidence, rationale: 'why' }, // no targetSkill
    ] }), 'sw1', () => 1)
    assert.equal(withoutTarget.length, 0)

    const withoutBody = parseSynthesizeOutput(JSON.stringify({ proposals: [
      { kind, draft: { name: 'a-skill', description: 'd', body: '' }, evidence, rationale: 'why', targetSkill: 'a-skill' }, // empty body
    ] }), 'sw1', () => 1)
    assert.equal(withoutBody.length, 0)

    const ok = parseSynthesizeOutput(JSON.stringify({ proposals: [
      { kind, draft: { name: 'a-skill', description: 'd', body: 'full new body' }, evidence, rationale: 'why', targetSkill: 'a-skill' },
    ] }), 'sw1', () => 1)
    assert.equal(ok.length, 1)
    assert.equal(ok[0].kind, kind)
    assert.equal(ok[0].targetSkill, 'a-skill')
    assert.equal(ok[0].draft.body, 'full new body')
  })
}

test('parseSynthesizeOutput: retire requires targetSkill but NOT draft.body — accepted with an empty/absent draft', () => {
  const noTarget = parseSynthesizeOutput(JSON.stringify({ proposals: [
    { kind: 'retire', evidence, rationale: 'why' }, // no targetSkill → dropped
  ] }), 'sw1', () => 1)
  assert.equal(noTarget.length, 0)

  const noDraftAtAll = parseSynthesizeOutput(JSON.stringify({ proposals: [
    { kind: 'retire', evidence, rationale: 'why', targetSkill: 'stale-skill' }, // draft omitted entirely
  ] }), 'sw1', () => 1)
  assert.equal(noDraftAtAll.length, 1)
  assert.equal(noDraftAtAll[0].kind, 'retire')
  assert.equal(noDraftAtAll[0].targetSkill, 'stale-skill')
  assert.equal(noDraftAtAll[0].draft.body, '')

  const emptyBody = parseSynthesizeOutput(JSON.stringify({ proposals: [
    { kind: 'retire', draft: { name: 'stale-skill', description: '', body: '' }, evidence, rationale: 'why', targetSkill: 'stale-skill' },
  ] }), 'sw1', () => 1)
  assert.equal(emptyBody.length, 1)
  assert.equal(emptyBody[0].draft.body, '')
})

// ── Match (Cadence A — semantic matcher) ────────────────────────────────────

test('buildMatchPrompt: references shortlist keys, outPath, and the repeatable-core / variedThisRun instruction', () => {
  const p = buildMatchPrompt({
    procedures: [{ title: 'File quarterly taxes', skeleton: 'gather forms, compute, file', count: 1, struggle: true }],
    ledgerShortlist: [
      { key: 'file-taxes', title: 'File taxes', skeleton: 'gather forms, compute, file' },
      { key: 'edit-video', title: 'Edit talking-head video', skeleton: 'cut, caption, export' },
    ],
    outPath: '/out/match.json',
  })
  assert.ok(p.includes('/out/match.json'))
  assert.ok(p.includes('file-taxes') && p.includes('edit-video'))     // shortlist keys present
  assert.ok(/repeatable core/i.test(p))                               // the binding match rule
  assert.ok(/variedThisRun/.test(p))
  assert.ok(/file path|branch|ticket|account/i.test(p))                // examples of per-run specifics
  assert.ok(p.includes('"matches":[') || p.includes('{"matches":['))   // output contract shape
  assert.ok(!/reasoning/i.test(p))                                     // default: no dev-diagnostics ask
})

test('buildMatchPrompt: devMode adds the top-level reasoning ask', () => {
  const args = {
    procedures: [{ title: 'T', skeleton: 'S', count: 1, struggle: false }],
    ledgerShortlist: [{ key: 'k', title: 'T2', skeleton: 'S2' }],
    outPath: '/out/match.json',
  }
  assert.ok(!/reasoning/i.test(buildMatchPrompt(args)))
  assert.ok(!/reasoning/i.test(buildMatchPrompt({ ...args, devMode: false })))
  const dev = buildMatchPrompt({ ...args, devMode: true })
  assert.ok(/reasoning/i.test(dev))
  assert.ok(/developer diagnostics/i.test(dev))
})

test('parseMatchOutput: [] on null/malformed/matches-not-array', () => {
  assert.deepEqual(parseMatchOutput(null), [])
  assert.deepEqual(parseMatchOutput('not json'), [])
  assert.deepEqual(parseMatchOutput(JSON.stringify({ matches: 'nope' })), [])
  assert.deepEqual(parseMatchOutput(JSON.stringify({})), [])
})

test('parseMatchOutput: drops malformed rows, coerces confidence, defaults variedThisRun, accepts matchedKey:null', () => {
  const out = parseMatchOutput(JSON.stringify({ matches: [
    { procedureIndex: 0, matchedKey: 'file-taxes', confidence: 0.8, variedThisRun: ['q3', 42, 'acct-9'] },
    { procedureIndex: 1, matchedKey: null, confidence: 0.4 },                 // no variedThisRun → []
    { procedureIndex: 'nope', matchedKey: 'x', confidence: 0.5 },             // dropped: non-numeric procedureIndex
    { procedureIndex: 2, matchedKey: '', confidence: 0.5 },                   // dropped: empty-string matchedKey
    { procedureIndex: 3, matchedKey: 42, confidence: 0.5 },                   // dropped: non-string/non-null matchedKey
    { procedureIndex: 4, matchedKey: null, confidence: 'high' },              // confidence coerced → 0
    'not an object',                                                          // dropped
  ] }))
  assert.equal(out.length, 3)
  assert.deepEqual(out[0], { procedureIndex: 0, matchedKey: 'file-taxes', confidence: 0.8, variedThisRun: ['q3', 'acct-9'] })
  assert.deepEqual(out[1], { procedureIndex: 1, matchedKey: null, confidence: 0.4, variedThisRun: [] })
  assert.deepEqual(out[2], { procedureIndex: 4, matchedKey: null, confidence: 0, variedThisRun: [] })
})

test('parseMatchOutput: nothing to match → []', () => {
  assert.deepEqual(parseMatchOutput(JSON.stringify({ matches: [] })), [])
})
