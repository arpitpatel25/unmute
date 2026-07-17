import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDistillPrompt, parseDistillOutput, buildSynthesizePrompt, parseSynthesizeOutput } from './curator-prompts.ts'

test('distill prompt: points at trace file, demands JSON at outPath, forbids facts/preferences', () => {
  const p = buildDistillPrompt({ taskId: 't1', intent: 'edit video', tracePath: '/tr/a.txt', outPath: '/out/distill.json', curatedNames: ['pr-review'] })
  assert.ok(p.includes('/tr/a.txt'))
  assert.ok(p.includes('/out/distill.json'))
  assert.ok(/never|not/i.test(p) && /fact|preference/i.test(p))   // D4 stated in-prompt
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

test('synthesize prompt: carries filter language, candidates with totals, rejections, feedback', () => {
  const p = buildSynthesizePrompt({
    sweepId: 'sw1',
    candidates: [{ key: 'k', title: 'T', skeleton: 'S', total: 3, struggle: true, firstSeen: 'a', lastSeen: 'b', occurrences: [] }],
    curatedIndex: [{ name: 'pr-review', description: 'd' }],
    rejections: [{ name: 'noise-skill', reason: 'too niche' }],
    feedback: [{ skill: 'pr-review', note: 'misses lockfiles' }],
    outPath: '/out/synth.json',
  })
  assert.ok(/CONSEQUENTIAL/.test(p) && /NON-OBVIOUS/.test(p) && /DURABLE/.test(p))
  assert.ok(/default is NO|when unsure, DON'T/i.test(p))
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
  assert.equal(out[0].resolution, null)
  assert.ok(out[0].id.startsWith('prop_'))
})
