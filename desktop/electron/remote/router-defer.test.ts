// The user waits for the ROUTE, not for the label.
//
// Routing decides four kinds of thing, and only some of them gate anything:
//   GATING     action, targetTaskId, intent, dir, kind, mode, surface, agent
//              — nothing can be dispatched without them.
//   COSMETIC   name, group — they decide what the card SAYS, and the task runs
//              identically whether they arrive now or five seconds from now.
//
// Measured 28 Aug: 15.9s and 24.0s from utterance to dispatch, all of it spent
// with the user staring at nothing. The two field rules below are the largest
// blocks in the prompt and the most reasoning-heavy part of the answer, and
// they were on the critical path for no reason.
//
// So the gating decision is asked for alone, and name+group are asked for
// afterwards in the same warm session — where the full prompt is still in
// context, so the follow-up is one sentence rather than a second routing call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Router, buildRoutingPrompt, buildEnrichPrompt, type AgentExecutor } from './router.ts'

const NONE: never[] = []
const GROUPS = [{ label: 'unmute marketing' }]

test('the gating prompt does not spend the user\'s wait on name and group', () => {
  const gating = buildRoutingPrompt('plan reddit marketing', NONE, '/tmp/d.json', NONE, NONE, NONE, NONE, NONE, undefined, GROUPS, { defer: true })
  const full = buildRoutingPrompt('plan reddit marketing', NONE, '/tmp/d.json', NONE, NONE, NONE, NONE, NONE, undefined, GROUPS)

  // The decision it still has to make.
  assert.match(gating, /"action":"new"/)
  assert.match(gating, /Decide: does this command START a new task/)
  // The label rules it no longer has to reason through first.
  assert.ok(!/LEAD WITH THE SUBJECT/.test(gating), 'naming rules still on the critical path')
  assert.ok(!/A group is a STREAM at the altitude/.test(gating), 'grouping rules still on the critical path')
  assert.ok(gating.length < full.length, 'the gating prompt should be the smaller of the two')
})

test('the enrichment prompt is a follow-up, not a second routing call', () => {
  const p = buildEnrichPrompt('/tmp/d.json')
  // It leans on the session context rather than restating the world.
  assert.ok(!/Open tasks you could continue/.test(p))
  // It carries the group rule (the gating prompt no longer does, and the
  // session context holds the LIVE GROUPS but not the rule for reading them).
  // What it must NOT do is restate the world: the task list, projects, the
  // wall, the species classification, the targeting rules.
  assert.ok(!/FIRST classify the command/.test(p))
  assert.ok(!/Lean CONTINUE when the command/.test(p))
  assert.ok(p.length < 4000, 'enrichment should be a follow-up, not a whole routing prompt')
  assert.match(p, /name/)
  assert.match(p, /group/)
  assert.match(p, /\/tmp\/d\.json/)
})

/** Writes `gating` on the routing prompt and `enrich` on the follow-up, so a
 *  test can assert what the caller saw at each point in time. */
function twoPhaseExecutor(decisionPath: string, gating: object, enrich: object | null) {
  let alive = true
  const seen: string[] = []
  const ex: AgentExecutor = {
    get alive() { return alive },
    async spawn() {}, async isReady() {},
    writeStdin(t: string) {
      const write = (o: object) => void fs.mkdir(path.dirname(decisionPath), { recursive: true })
        .then(() => fs.writeFile(decisionPath, JSON.stringify(o)))
      // "Spoken command:" appears only in the routing prompt itself - the
      // schema-correction retry also carries the [Unmute router] banner, and
      // counting it as a second route hid what these tests are measuring.
      if (t.includes('Spoken command:')) { seen.push('gating'); write(gating) }
      else if (/name and group/i.test(t)) { seen.push('enrich'); if (enrich) write(enrich) }
    },
    write() {}, resize() {}, onData() {}, kill() { alive = false },
  }
  return { ex, seen }
}

test('route returns as soon as it can dispatch; the label follows behind', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-defer-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  const { ex, seen } = twoPhaseExecutor(
    decisionPath,
    { action: 'new', intent: 'plan reddit marketing', kind: 'session' },
    { name: 'Reddit marketing plan', group: 'unmute marketing' },
  )
  const router = new Router({ executorFactory: () => ex, baseDir, readyGraceMs: 0, submitConfirmMs: 0, decisionTimeoutMs: 1000, pollMs: 20, deferNaming: true })

  const d = await router.route('plan reddit marketing', NONE, NONE, NONE, NONE, NONE, NONE, undefined, GROUPS)
  assert.equal(d.action, 'new')
  assert.equal(seen.length, 1, 'route waited for the enrichment it should not have waited for')
  assert.ok(d.enrich, 'no enrichment was promised')

  const late = await d.enrich!
  assert.equal(late.name, 'Reddit marketing plan')
  assert.equal(late.group, 'unmute marketing')
  assert.deepEqual(seen, ['gating', 'enrich'])

  await router.settleHousekeeping()
  router.dispose()
})

test('a failed enrichment leaves the task dispatched and unnamed, never blocked', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-defer2-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  const { ex } = twoPhaseExecutor(decisionPath, { action: 'new', intent: 'x', kind: 'oneoff' }, null)
  const router = new Router({ executorFactory: () => ex, baseDir, readyGraceMs: 0, submitConfirmMs: 0, decisionTimeoutMs: 200, pollMs: 20, deferNaming: true })

  const d = await router.route('x', NONE, NONE, NONE, NONE, NONE, NONE, undefined, GROUPS)
  assert.equal(d.action, 'new')
  const late = await d.enrich!          // resolves, never rejects
  assert.equal(late.name, undefined)
  assert.equal(late.group, undefined)

  await router.settleHousekeeping()
  router.dispose()
})

test('only NEW tasks are enriched — continue/speak have no card to name', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-defer3-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  const { ex, seen } = twoPhaseExecutor(decisionPath, { action: 'speak', intent: 'what is going on' }, { name: 'no', group: 'no' })
  const router = new Router({ executorFactory: () => ex, baseDir, readyGraceMs: 0, submitConfirmMs: 0, decisionTimeoutMs: 200, pollMs: 20, deferNaming: true })

  const d = await router.route('what is going on', NONE, NONE, NONE, NONE, NONE, NONE, undefined, GROUPS)
  assert.equal(d.action, 'speak')
  assert.equal(d.enrich, undefined)
  await router.settleHousekeeping()
  assert.deepEqual(seen, ['gating'], 'a speak decision should never ask for a name')
  router.dispose()
})

test('with deferNaming off, the old single-call behaviour is unchanged', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-defer4-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  const { ex, seen } = twoPhaseExecutor(
    decisionPath,
    { action: 'new', intent: 'x', kind: 'oneoff', name: 'Inline name', group: 'unmute marketing' },
    null,
  )
  const router = new Router({ executorFactory: () => ex, baseDir, readyGraceMs: 0, submitConfirmMs: 0, decisionTimeoutMs: 500, pollMs: 20, deferNaming: false })

  const d = await router.route('x', NONE, NONE, NONE, NONE, NONE, NONE, undefined, GROUPS)
  assert.equal(d.name, 'Inline name')
  assert.equal(d.group, 'unmute marketing')
  assert.equal(d.enrich, undefined)
  await router.settleHousekeeping()
  assert.deepEqual(seen, ['gating'])
  router.dispose()
})
