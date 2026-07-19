import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDistillPrompt, parseDistillOutput, parseDistillReasoning, buildSynthesizePrompt, parseSynthesizeOutput, parseSynthesizeReasoning } from './curator-prompts.ts'

test('distill prompt: points at trace file, demands JSON at outPath, forbids facts/preferences + app-navigation, asks for methods', () => {
  const p = buildDistillPrompt({ taskId: 't1', intent: 'edit video', tracePath: '/tr/a.txt', outPath: '/out/distill.json', curatedNames: ['pr-review'] })
  assert.ok(p.includes('/tr/a.txt'))
  assert.ok(p.includes('/out/distill.json'))
  assert.ok(/never|not/i.test(p) && /fact|preference/i.test(p))   // D4 stated in-prompt
  assert.ok(/METHOD|WORKFLOW|STANDARD/.test(p))                   // D3 — methods, not procedures
  assert.ok(/app-navigation|click-sequence|tool-operation/i.test(p)) // D18/D19 — app-navigation excluded
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

test('synthesize prompt: method-oriented filter excludes app-navigation, asks for changeSummary + full body, keeps restraint', () => {
  const p = buildSynthesizePrompt({
    sweepId: 'sw1',
    candidates: [{ key: 'k', title: 'T', skeleton: 'S', total: 3, struggle: true, firstSeen: 'a', lastSeen: 'b', occurrences: [] }],
    curatedIndex: [{ name: 'pr-review', description: 'd', body: '## Goal\nreview' }],
    rejections: [{ name: 'noise-skill', reason: 'too niche' }],
    feedback: [{ skill: 'pr-review', note: 'misses lockfiles' }],
    outPath: '/out/synth.json',
  })
  assert.ok(/METHOD|WORKFLOW|STANDARD/.test(p))                    // D3 — target is methods
  assert.ok(/app-navigation|click-sequence|tool-operation/i.test(p)) // navigation explicitly excluded
  assert.ok(/default is NO|when unsure, DON'T/i.test(p))           // restraint posture stays
  assert.ok(/changeSummary/.test(p))                              // D20 plain-language summary
  assert.ok(/full[^\n]*body|complete[^\n]*body/i.test(p))         // update emits full body
  assert.ok(!/unified diff of the body/i.test(p))                 // no hand-written diff
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
    { kind: 'update', draft: { name: 'a-skill', description: 'd', body: 'new body' },
      evidence: { occurrences: 1, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 0, recoveries: 0, wallClockMin: 1 } },
      rationale: 'why', targetSkill: 'a-skill', diff: '--- fabricated\n+++ fiction\n+not real' },
  ] }), 'sw1', () => 1)
  assert.equal(out.length, 1)
  assert.equal(out[0].diff, undefined)   // the LLM's diff is dropped; only the deterministic sweep sets it
})
