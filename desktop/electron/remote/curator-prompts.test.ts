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

// Anti-drift guard: the Cadence-B judge prompt MUST literally carry the binding
// two-door selection philosophy. These substring assertions are the project's
// guard against the prompt silently drifting away from the decided design.
// (Replaces the retired v2 "three tests / GAP-TASK-REUSE / struggle-is-PRIMARY"
// test — that framing was deliberately superseded by the two doors, where
// struggle is one input rather than the gate.)
test('synthesize prompt (Cadence-B two-door judge): binding rules render verbatim + evidence/rejections/feedback', () => {
  const p = buildSynthesizePrompt({
    sweepId: 'sw1',
    candidates: [{ key: 'k', title: 'T', skeleton: 'S', total: 3, struggle: true, firstSeen: 'a', lastSeen: 'b', occurrences: [] }],
    curatedIndex: [{ name: 'pr-review', description: 'd', body: '## Goal\nreview' }],
    rejections: [{ name: 'noise-skill', reason: 'too niche' }],
    feedback: [{ skill: 'pr-review', note: 'misses lockfiles' }],
    outPath: '/out/synth.json',
  })
  // Rule 1 — two doors. Door 1 (strong prior) with the verbatim human-glad test.
  assert.ok(/Door 1/.test(p) && /Door 2/.test(p))
  assert.ok(p.includes('If this never happens again, would a human still be glad this skill exists?'))
  assert.ok(/single sighting|SINGLE sighting|one sighting/i.test(p))     // Door 1 may graduate on 1
  // Rule 2 — the ≥2 rule: a Door-2 recurrence skill needs ≥2 distinct sessions.
  assert.ok(/at least 2 distinct sessions/i.test(p))
  // Rule 3 — struggle is one input, not the gate (NOT the old "PRIMARY" framing).
  assert.ok(p.includes('Struggle is one input, not the gate.'))
  assert.ok(!/PRIMARY/.test(p))
  // Rule 4 — FEW is the goal; cross-cutting disciplines / incidental navigation excluded.
  assert.ok(/FEW is the goal/.test(p))
  assert.ok(/no cross-cutting/i.test(p))
  assert.ok(/recurring cross-app/i.test(p))                              // a recurring cross-app task IS fine
  // Rule 5 — hardcode-vs-slot: only run-to-run-changing values become slots; secrets from env/keychain.
  assert.ok(/change from run to run/i.test(p))
  assert.ok(/secret/i.test(p) && /env|keychain/i.test(p))
  // Rule 6 — skills independent; no cross-skill facts store; only parent→child composition.
  assert.ok(/independent/i.test(p) && /no cross-skill facts/i.test(p))
  assert.ok(/parent.?child composition/i.test(p))
  // Rule 7 — typed output contract lists all 5 kinds; full body not a diff.
  for (const kind of ['create', 'narrow', 'split', 'merge', 'retire']) assert.ok(p.includes(kind), `missing kind ${kind}`)
  assert.ok(/full[^\n]*body|complete[^\n]*body/i.test(p))                // narrow/split/merge emit the COMPLETE new body
  assert.ok(!/unified diff of the body/i.test(p))                        // never a hand-written diff
  assert.ok(/changeSummary/.test(p))
  // Restraint posture preserved.
  assert.ok(/when unsure, DON'T/i.test(p))
  // Candidate evidence rendered: occurrences + distinct-session count.
  assert.ok(p.includes('seen 3x') && /distinct session/i.test(p))
  assert.ok(p.includes('too niche'))                                    // rejections rendered
  assert.ok(p.includes('misses lockfiles'))                             // feedback rendered
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

test('parseSynthesizeOutput: sourceKeys pass through when a non-empty string array, else omitted', () => {
  const out = parseSynthesizeOutput(JSON.stringify({ proposals: [
    { kind: 'create', draft: { name: 'a-skill', description: 'd', body: 'b' },
      evidence: { occurrences: 1, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 0, recoveries: 0, wallClockMin: 1 } },
      rationale: 'why', sourceKeys: ['load-video', 'other-key', '', 42] },   // '' and 42 filtered out
    { kind: 'create', draft: { name: 'b-skill', description: 'd', body: 'b' },
      evidence: { occurrences: 1, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 0, recoveries: 0, wallClockMin: 1 } },
      rationale: 'why' },                                                    // absent → undefined, proposal survives
    { kind: 'create', draft: { name: 'c-skill', description: 'd', body: 'b' },
      evidence: { occurrences: 1, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 0, recoveries: 0, wallClockMin: 1 } },
      rationale: 'why', sourceKeys: 'not-an-array' },                        // malformed → omitted, proposal survives
  ] }), 'sw1', () => 1)
  assert.equal(out.length, 3)
  assert.deepEqual(out[0].sourceKeys, ['load-video', 'other-key'])
  assert.equal(out[1].sourceKeys, undefined)
  assert.equal(out[2].sourceKeys, undefined)
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
