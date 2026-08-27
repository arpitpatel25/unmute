import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateDecision, correctionPrompt, Router, type RoutableTask } from './router.ts'

const NO_TASKS: RoutableTask[] = []

/** An engine that answers badly once, then correctly — the field case. */
function flakyEngine(bad: string, good: string) {
  const prompts: string[] = []
  return {
    prompts,
    engine: {
      async warm() {},
      async decide(prompt: string) { prompts.push(prompt); return prompts.length === 1 ? bad : good },
      dispose() {},
    },
  }
}

test('an off-schema reply is corrected, and the task keeps its name and group', async () => {
  const bad = JSON.stringify({
    action: 'new', group: 'twitter marketing',
    task: "Discuss Unmute's Twitter marketing", reasoning: 'no open tasks',
  })
  const good = JSON.stringify({
    action: 'new', intent: "Discuss Unmute's Twitter marketing",
    name: 'Unmute twitter strategy', kind: 'oneoff', group: 'unmute marketing',
  })
  const { engine, prompts } = flakyEngine(bad, good)
  const router = new Router({ executorFactory: () => { throw new Error('unused') }, engine, slot: 'test' })

  const d = await router.route('so there was this idea', NO_TASKS)

  assert.equal(d.name, 'Unmute twitter strategy', 'the name survived instead of falling back to raw speech')
  assert.equal(d.intent, "Discuss Unmute's Twitter marketing")
  assert.equal(d.kind, 'oneoff')
  assert.equal(d.group, 'unmute marketing')
  assert.equal(prompts.length, 2, 'exactly one correction')
  assert.match(prompts[1], /could not be used/)
  assert.match(prompts[1], /"task"/, 'the correction names the key it got wrong')
})

test('a reply that is still wrong after one correction falls to the failsafe', async () => {
  const bad = JSON.stringify({ action: 'new', task: 'x' })
  const { engine, prompts } = flakyEngine(bad, bad)
  const router = new Router({ executorFactory: () => { throw new Error('unused') }, engine, slot: 'test2' })

  const d = await router.route('do a thing', NO_TASKS)

  assert.equal(prompts.length, 2, 'one correction only — never a loop')
  assert.equal(d.action, 'new')
  assert.equal(d.intent, 'do a thing', 'the raw utterance still gets dispatched')
})

test('a good first answer is never asked twice', async () => {
  const good = JSON.stringify({ action: 'new', intent: 'x', name: 'X thing', kind: 'oneoff' })
  const { engine, prompts } = flakyEngine(good, good)
  const router = new Router({ executorFactory: () => { throw new Error('unused') }, engine, slot: 'test3' })

  await router.route('x', NO_TASKS)

  assert.equal(prompts.length, 1, 'the happy path costs exactly what it did before')
})

test('a well-formed new decision passes', () => {
  const out = validateDecision(JSON.stringify({
    action: 'new', intent: 'discuss twitter strategy',
    name: 'Unmute twitter strategy', kind: 'oneoff',
  }))
  assert.equal(out.ok, true)
})

test('the shape that actually shipped a nameless task is caught', () => {
  // Verbatim from the field, 2026-08-27 19:59: the model answered with `task`
  // and `reasoning` instead of `intent`, `name` and `kind`. Every one of those
  // was silently defaulted, so the card showed the raw transcript and the group
  // was dropped for being a one-off nobody had chosen.
  const out = validateDecision(JSON.stringify({
    action: 'new',
    group: 'twitter marketing',
    task: "Discuss an idea for Unmute's Twitter marketing",
    reasoning: 'No open tasks exist to continue',
  }))
  assert.equal(out.ok, false)
  assert.match(out.complaint!, /intent/)
  assert.match(out.complaint!, /name/)
  assert.match(out.complaint!, /kind/)
})

test('a reply that used `task` is told which key it should have been', () => {
  const out = validateDecision(JSON.stringify({ action: 'new', task: 'do a thing' }))
  assert.equal(out.ok, false)
  assert.match(out.complaint!, /"task"/, 'name the wrong key back to it, not just the missing one')
})

test('unparseable output is caught rather than falling straight to failsafe', () => {
  const out = validateDecision('here is the json you asked for: {oops')
  assert.equal(out.ok, false)
  assert.match(out.complaint!, /JSON/i)
})

test('a missing reply is not a schema complaint — nothing came back to correct', () => {
  // A timeout must keep going to the failsafe. Re-asking a session that never
  // answered just spends the budget twice.
  assert.equal(validateDecision(null).ok, false)
  assert.equal(validateDecision(null).retryable, false)
})

test('an unknown action is caught', () => {
  const out = validateDecision(JSON.stringify({ action: 'frobnicate', intent: 'x' }))
  assert.equal(out.ok, false)
  assert.match(out.complaint!, /action/)
})

test('continue and resume must name the task they target', () => {
  const cont = validateDecision(JSON.stringify({ action: 'continue', intent: 'more' }))
  assert.equal(cont.ok, false)
  assert.match(cont.complaint!, /targetTaskId/)
  const res = validateDecision(JSON.stringify({ action: 'resume', intent: 'more' }))
  assert.match(res.complaint!, /targetTaskId/)
})

test('curate must carry ops, or nothing happens at all', () => {
  const out = validateDecision(JSON.stringify({ action: 'curate', intent: 'group these' }))
  assert.equal(out.ok, false)
  assert.match(out.complaint!, /ops/)
})

test('speak needs no target — an overall status question has none', () => {
  assert.equal(validateDecision(JSON.stringify({ action: 'speak', intent: "what's going on" })).ok, true)
})

test('the correction says what was wrong and asks only for the JSON again', () => {
  const p = correctionPrompt('missing required key "name"', null)
  assert.match(p, /missing required key "name"/)
  assert.match(p, /\[Unmute router\]/)
  assert.match(p, /ONLY/)
})

test('the file-based correction repeats where the JSON must be written', () => {
  const p = correctionPrompt('not JSON', '/tmp/router/decision.json')
  assert.match(p, /\/tmp\/router\/decision\.json/)
})
