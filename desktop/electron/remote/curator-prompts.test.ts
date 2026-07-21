import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDistillPrompt, parseDistillOutput, parseDistillReasoning, buildSynthesizePrompt, parseSynthesizeOutput, parseSynthesizeReasoning, buildMatchPrompt, parseMatchOutput, parseMatchReasoning, buildAuditPrompt, parseAuditOutput, parseAuditReasoning } from './curator-prompts.ts'

// Anti-drift guard (spec §0 A/B/D/G): the distill prompt is USER-SIDE. These
// substring assertions pin the re-aim and assert the OLD model-work / struggle-
// primary framing is gone. If someone drifts the prompt back toward mining the
// model's work, these fail.
test('distill prompt (user-side re-aim): user-index rule, entry test, corrections-as-struggle; old model-work/PRIMARY framing GONE', () => {
  const p = buildDistillPrompt({ taskId: 't1', intent: 'edit video', tracePath: '/tr/a.txt', outPath: '/out/distill.json', curatedSkills: [{ name: 'pr-review', description: 'review a pull request' }] })
  assert.ok(p.includes('/tr/a.txt'))
  assert.ok(p.includes('/out/distill.json'))
  // A — the user's turns are the index; the model side is read only where the user points.
  assert.ok(/user'?s turns as the index/i.test(p))
  assert.ok(/only where a user message points/i.test(p))
  assert.ok(/never\s+open-scan/i.test(p))
  // B — the entry test: actionable intent AND reusable context supplied, both required.
  assert.ok(/actionable intent/i.test(p) && /reusable context/i.test(p))
  assert.ok(/emit a finding only when both/i.test(p))
  assert.ok(/discussion-only/i.test(p) && /emits nothing/i.test(p))   // discussions produce nothing (the normal case)
  // D — struggle is the USER's corrections, not model errors.
  assert.ok(/struggle signal is the\s+USER'?s corrections/i.test(p))
  assert.ok(/not the\s+model'?s errors/i.test(p))
  // G — personal, not general.
  assert.ok(/personal, not general/i.test(p))
  // Output contract is the new findings shape.
  assert.ok(/"findings":\[/.test(p) && /"contextSupplied"/.test(p))
  assert.ok(p.includes('pr-review'))                                 // curated names still rendered
  // OLD framing removed (clean removal, spec §0 removal list).
  assert.ok(!/pieces of WORK/i.test(p))
  assert.ok(!/PRIMARY/.test(p))
  assert.ok(!/MOST IMPORTANT/i.test(p))
  assert.ok(!/"procedures":\[/.test(p))                              // no legacy output shape
  // Task 3: the agree/diverge modification signal is RELOCATED to the audit
  // pass — distill no longer emits skillObservation.
  assert.ok(!/skillObservation/.test(p))
  assert.ok(!/MODIFICATION SIGNAL/i.test(p))
  assert.ok(!/agree.*diverge|diverge.*agree/i.test(p))
})

test('distill prompt: renders existing skills WITH descriptions (for usedCuratedSkill friction); NO skillObservation ask (moved to audit)', () => {
  const p = buildDistillPrompt({
    taskId: 't1', intent: 'review a PR', tracePath: '/tr/a.txt', outPath: '/out/distill.json',
    curatedSkills: [
      { name: 'pr-review', description: 'review a pull request end to end' },
      { name: 'extract-invoice', description: 'pull structured fields from an invoice PDF' },
    ],
  })
  // Both name AND description still render (the usedCuratedSkill friction report needs them).
  assert.ok(p.includes('pr-review') && p.includes('review a pull request end to end'))
  assert.ok(p.includes('extract-invoice') && p.includes('pull structured fields from an invoice PDF'))
  assert.ok(/usedCuratedSkill/.test(p))
  // Task 3: the agree/diverge modification signal is gone from distill.
  assert.ok(!/skillObservation/.test(p))
  assert.ok(!/"skillObservation"/.test(p))
})

test('parseDistillOutput: maps a valid finding — PRIMARY + compat fields populated; correction drives struggle', () => {
  assert.deepEqual(parseDistillOutput(null), [])
  assert.deepEqual(parseDistillOutput('not json'), [])
  const out = parseDistillOutput(JSON.stringify({ findings: [
    { intent: 'edit a talking-head video', contextSupplied: ['crop to 9:16', 'burn captions'],
      correction: 'no, use the CLI not the desktop app', bodySketch: 'trim silence, crop, caption', count: 2 },
  ] }))
  assert.equal(out.length, 1)
  const f = out[0]
  // PRIMARY user-side fields
  assert.equal(f.intent, 'edit a talking-head video')
  assert.deepEqual(f.contextSupplied, ['crop to 9:16', 'burn captions'])
  assert.equal(f.correction, 'no, use the CLI not the desktop app')
  assert.equal(f.bodySketch, 'trim silence, crop, caption')
  // compat fields kept populated for downstream
  assert.equal(f.title, 'edit a talking-head video')       // title = intent
  assert.equal(f.skeleton, 'trim silence, crop, caption')  // skeleton = bodySketch
  assert.equal(f.count, 2)
  assert.equal(f.struggle, true)                           // struggle = !!correction
})

test('parseDistillOutput: ENTRY TEST — drops a finding with no actionable intent or empty context; discussion-only → []', () => {
  // discussion-only session → nothing (the normal case)
  assert.deepEqual(parseDistillOutput(JSON.stringify({ findings: [] })), [])
  const out = parseDistillOutput(JSON.stringify({ findings: [
    { intent: 'sweep my Gmail accounts', contextSupplied: ['both work + personal inboxes'], bodySketch: 'B' }, // kept
    { intent: '', contextSupplied: ['x'], bodySketch: 'B' },                    // dropped: no actionable intent
    { intent: 'no context intent', contextSupplied: [], bodySketch: 'B' },      // dropped: empty context
    { intent: 'no context field', bodySketch: 'B' },                            // dropped: context absent
    { intent: 'blank context items', contextSupplied: ['', '   '], bodySketch: 'B' }, // dropped: no non-empty items
  ] }))
  assert.equal(out.length, 1)
  assert.equal(out[0].intent, 'sweep my Gmail accounts')
  assert.equal(out[0].struggle, false)   // no correction → struggle false (its absence never rejects the finding)
})

test('parseDistillOutput: no longer returns skillObservation (relocated to the audit pass, Task 3)', () => {
  const out = parseDistillOutput(JSON.stringify({ findings: [
    { intent: 'A', contextSupplied: ['c'], bodySketch: 'S',
      skillObservation: { skill: 'pr-review', verdict: 'diverge', note: 'skipped the lockfile check' } },
    { intent: 'B', contextSupplied: ['c'], bodySketch: 'S',
      skillObservation: { skill: 'extract-invoice', verdict: 'agree', note: 'same fields, same order' } },
  ] }))
  assert.equal(out.length, 2)                              // the findings themselves survive (entry test still passes)
  for (const p of out) assert.equal(p.skillObservation, undefined)  // but distill never reads/populates it now
})

// ── Audit (Cadence A — skill-usage audit pass, spec §0 E) ──────────────────

test('buildAuditPrompt: renders the invoked-skill list, the finished-vs-stage-X judgment, and the ok/extend/wrong contract', () => {
  const p = buildAuditPrompt({ skillsInvoked: ['pr-review', 'extract-invoice'], tracePath: '/tr/a.txt', outPath: '/out/audit.json' })
  assert.ok(p.includes('/tr/a.txt'))
  assert.ok(p.includes('/out/audit.json'))
  // Each invoked skill is listed for judgment.
  assert.ok(p.includes('pr-review') && p.includes('extract-invoice'))
  // Read AROUND the invocation.
  assert.ok(/around the invocation/i.test(p))
  // The finished-vs-stage-X question.
  assert.ok(/finish(ed)? the job/i.test(p))
  assert.ok(/stage/i.test(p) && /hand-?drove|hand-?drive|by hand|the rest/i.test(p))
  // The three-verdict contract.
  assert.ok(/\bok\b/i.test(p) && /\bextend\b/i.test(p) && /\bwrong\b/i.test(p))
  assert.ok(/did the job/i.test(p))       // ok = did the job
  assert.ok(/partway|more|fell short|short of/i.test(p))   // extend = got partway
  assert.ok(/wrong thing|rejected/i.test(p))               // wrong = wrong thing / user rejected
  // Output contract.
  assert.ok(/"audits":\[/.test(p))
  assert.ok(/"verdict"/.test(p) && /"note"/.test(p) && /"skill"/.test(p))
  assert.ok(!/reasoning/i.test(p))        // default: no dev-diagnostics ask
})

test('buildAuditPrompt: devMode adds the top-level reasoning ask (Task 1 convention)', () => {
  const args = { skillsInvoked: ['pr-review'], tracePath: '/tr/a.txt', outPath: '/out/audit.json' }
  assert.ok(!/reasoning/i.test(buildAuditPrompt(args)))
  assert.ok(!/reasoning/i.test(buildAuditPrompt({ ...args, devMode: false })))
  const dev = buildAuditPrompt({ ...args, devMode: true })
  assert.ok(/reasoning/i.test(dev))
  assert.ok(/developer diagnostics/i.test(dev))
})

test('parseAuditOutput: maps valid rows; drops invalid verdicts and empty skills', () => {
  assert.deepEqual(parseAuditOutput(null), [])
  assert.deepEqual(parseAuditOutput('not json'), [])
  assert.deepEqual(parseAuditOutput(JSON.stringify({ audits: 'nope' })), [])
  assert.deepEqual(parseAuditOutput(JSON.stringify({})), [])
  const out = parseAuditOutput(JSON.stringify({ audits: [
    { skill: 'pr-review', verdict: 'ok', note: 'did the whole review' },
    { skill: 'extract-invoice', verdict: 'extend', note: 'stopped before the totals' },
    { skill: 'setup-mcp', verdict: 'wrong', note: 'user reverted it' },
    { skill: 'bad-verdict', verdict: 'maybe', note: 'n' },       // dropped: invalid verdict
    { skill: '', verdict: 'ok', note: 'n' },                     // dropped: empty skill
    { skill: '   ', verdict: 'ok', note: 'n' },                  // dropped: blank skill
    { skill: 'no-note', verdict: 'ok' },                         // dropped: note not a string
    { verdict: 'ok', note: 'n' },                                // dropped: no skill
    'not an object',                                             // dropped
  ] }))
  assert.equal(out.length, 3)
  assert.deepEqual(out[0], { skill: 'pr-review', verdict: 'ok', note: 'did the whole review' })
  assert.deepEqual(out[1], { skill: 'extract-invoice', verdict: 'extend', note: 'stopped before the totals' })
  assert.deepEqual(out[2], { skill: 'setup-mcp', verdict: 'wrong', note: 'user reverted it' })
})

test('parseAuditOutput: nothing to audit → []', () => {
  assert.deepEqual(parseAuditOutput(JSON.stringify({ audits: [] })), [])
})

test('parseAuditReasoning (DEV-ONLY): captures a top-level reasoning field when present; undefined otherwise; never leaks onto a row', () => {
  assert.equal(parseAuditReasoning(null), undefined)
  assert.equal(parseAuditReasoning('not json'), undefined)
  assert.equal(parseAuditReasoning(JSON.stringify({ audits: [] })), undefined)
  assert.equal(parseAuditReasoning(JSON.stringify({ audits: [], reasoning: '  ' })), undefined)
  assert.equal(parseAuditReasoning(JSON.stringify({ audits: [], reasoning: 'judged pr-review ok' })), 'judged pr-review ok')
  // reason/reasoning can never leak onto an audit row.
  const rows = parseAuditOutput(JSON.stringify({
    audits: [{ skill: 'pr-review', verdict: 'ok', note: 'n', reasoning: 'row reasoning', reason: 'row reason' }],
    reasoning: 'top',
  }))
  assert.equal(rows.length, 1)
  assert.deepEqual(Object.keys(rows[0]).sort(), ['note', 'skill', 'verdict'])
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
  // Rule 8 — narrow requires REPEATED divergence (≥ twice), not a single event.
  assert.ok(/at least twice|at least 2|twice/i.test(p))
  assert.ok(/repeat/i.test(p))
  assert.ok(/single divergence is NOT enough|single divergence is not enough|a single divergence/i.test(p))
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
  const dArgs = { taskId: 't1', intent: 'edit video', tracePath: '/tr/a.txt', outPath: '/out/distill.json', curatedSkills: [{ name: 'pr-review', description: 'review a pull request' }] }
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
  assert.equal(parseDistillReasoning(JSON.stringify({ findings: [] })), undefined)   // absent
  assert.equal(parseDistillReasoning(JSON.stringify({ findings: [], reasoning: '   ' })), undefined) // blank → undefined
  assert.equal(parseDistillReasoning(JSON.stringify({ findings: [], reasoning: 'excluded X because discussion-only' })), 'excluded X because discussion-only')
  // The main parser is unaffected by a reasoning field (decision path unchanged).
  assert.equal(parseDistillOutput(JSON.stringify({ findings: [{ intent: 'T', contextSupplied: ['c'], bodySketch: 'S' }], reasoning: 'r' })).length, 1)

  assert.equal(parseSynthesizeReasoning(JSON.stringify({ proposals: [] })), undefined)
  assert.equal(parseSynthesizeReasoning(JSON.stringify({ proposals: [], reasoning: 'considered all candidates' })), 'considered all candidates')

  // The match stage gets the same convention as distill/synthesize — a
  // top-level `reasoning` string, read separately, never fed into a decision.
  assert.equal(parseMatchReasoning(null), undefined)
  assert.equal(parseMatchReasoning(JSON.stringify({ matches: [] })), undefined)
  assert.equal(parseMatchReasoning(JSON.stringify({ matches: [], reasoning: 'matched on repeatable core' })), 'matched on repeatable core')
})

// Constraint F (spec §0): reason is dev-log-only — it must NEVER be reachable
// through a proposal draft or a distilled procedure, however the model shapes
// its raw JSON. These lock the contract so a later prompt/parser change can't
// quietly open a leak path.
test('reasoning/reason can NEVER leak onto a distilled finding, whatever field the model used', () => {
  const raw = JSON.stringify({
    findings: [{ intent: 'T', contextSupplied: ['c'], bodySketch: 'S', reasoning: 'per-finding reasoning', reason: 'per-finding reason' }],
    reasoning: 'top-level reasoning',
  })
  const procs = parseDistillOutput(raw)
  assert.equal(procs.length, 1)
  assert.ok(!Object.prototype.hasOwnProperty.call(procs[0], 'reasoning'))
  assert.ok(!Object.prototype.hasOwnProperty.call(procs[0], 'reason'))
})

test('reasoning/reason can NEVER leak onto a proposal draft, whatever field the model used', () => {
  const raw = JSON.stringify({
    proposals: [{
      kind: 'create',
      draft: { name: 'extract-invoice', description: 'd', body: 'b', reasoning: 'draft-level reasoning', reason: 'draft-level reason' },
      evidence: { occurrences: 1 },
      rationale: 'r',
      reasoning: 'proposal-level reasoning',
      reason: 'proposal-level reason',
    }],
    reasoning: 'batch-level reasoning',
  })
  const proposals = parseSynthesizeOutput(raw, 'sw_1', () => 1000)
  assert.equal(proposals.length, 1)
  const [p] = proposals
  assert.ok(!Object.prototype.hasOwnProperty.call(p.draft, 'reasoning'))
  assert.ok(!Object.prototype.hasOwnProperty.call(p.draft, 'reason'))
  assert.ok(!Object.prototype.hasOwnProperty.call(p, 'reasoning'))
  assert.ok(!Object.prototype.hasOwnProperty.call(p, 'reason'))
  assert.deepEqual(Object.keys(p.draft).sort(), ['body', 'description', 'name'])
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

test('parseSynthesizeOutput: NORMALIZES evidence missing struggle/sessions (I2 — backfill/popup read them unconditionally)', () => {
  // A judge that emits only `occurrences` (no struggle, no sessions) must not
  // yield a proposal whose evidence.struggle is undefined — the sweep backfill
  // and the popup both dereference struggle.errors / sessions.length.
  const out = parseSynthesizeOutput(JSON.stringify({ proposals: [
    { kind: 'create', draft: { name: 'video-load-premiere', description: 'd', body: 'b' },
      evidence: { occurrences: 3 }, rationale: 'why' },
  ] }), 'sw1', () => 1)
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].evidence.struggle, { errors: 0, recoveries: 0, wallClockMin: 0 })
  assert.deepEqual(out[0].evidence.sessions, [])
  assert.equal(out[0].evidence.occurrences, 3)
  // firstSeen/lastSeen default to strings (never undefined)
  assert.equal(typeof out[0].evidence.firstSeen, 'string')
  assert.equal(typeof out[0].evidence.lastSeen, 'string')
})

test('parseSynthesizeOutput: coerces numeric struggle fields and drops malformed session entries (I2)', () => {
  const out = parseSynthesizeOutput(JSON.stringify({ proposals: [
    { kind: 'create', draft: { name: 'a-skill', description: 'd', body: 'b' },
      evidence: {
        occurrences: 2,
        sessions: [
          { id: 's1', intent: 'work', at: 't', tracePointer: 'traces/a' },  // well-formed → kept
          { id: 's2' },                                                      // malformed → dropped
          'nonsense',                                                        // malformed → dropped
        ],
        struggle: { errors: '5', recoveries: 2, wallClockMin: null },        // errors non-numeric, wallClockMin null
      }, rationale: 'why' },
  ] }), 'sw1', () => 1)
  assert.equal(out.length, 1)
  assert.equal(out[0].evidence.sessions.length, 1)
  assert.equal(out[0].evidence.sessions[0].id, 's1')
  assert.deepEqual(out[0].evidence.struggle, { errors: 0, recoveries: 2, wallClockMin: 0 })
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
