import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildRoutingPrompt, parseDecision, failsafeDecision, Router, type RoutableTask } from './router.ts'
import type { AgentExecutor } from './executor.ts'

const TASKS: RoutableTask[] = [{ id: 't1', intent: 'find latest tweet', state: 'done', category: 'info', ageSec: 5, surfaced: true }]
const ONE: RoutableTask[] = [{ id: 't1', intent: 'messi 2019 stats', state: 'done', category: 'info', ageSec: 30, surfaced: true }]
const TWO: RoutableTask[] = [
  { id: 't1', intent: 'messi 2019 stats', state: 'done', category: 'info', ageSec: 30, surfaced: true },
  { id: 't2', intent: 'open downloads', state: 'done', category: 'navigate', ageSec: 60, surfaced: false },
]

test('buildRoutingPrompt includes the utterance, task line, and decision path', () => {
  const p = buildRoutingPrompt('reply to it', TASKS, '/d/decision.json')
  assert.ok(p.includes('reply to it'))
  assert.ok(p.includes('[t1] "find latest tweet"'))
  assert.ok(p.includes('ON SCREEN'))
  assert.ok(p.includes('/d/decision.json'))
})

test('failsafeDecision: one recent task continues it; multiple or stale or none ⇒ new', () => {
  assert.deepEqual(failsafeDecision(ONE, 'and 2015?'), { action: 'continue', targetTaskId: 't1', intent: 'and 2015?', mode: 'managed' })
  assert.equal(failsafeDecision(TWO, 'x').action, 'new')               // ambiguous ⇒ new
  assert.equal(failsafeDecision([], 'x').action, 'new')                // nothing to continue
  const stale: RoutableTask[] = [{ ...ONE[0], ageSec: 99999 }]
  assert.equal(failsafeDecision(stale, 'x').action, 'new')             // too old ⇒ new
})

test('buildRoutingPrompt surfaces a blocked task and its question so the router can answer it', () => {
  const blocked: RoutableTask[] = [{ id: 't1', intent: 'open messi stats', state: 'needs-user', ageSec: 8, surfaced: true, awaiting: true, question: 'What would you like me to open?' }]
  const p = buildRoutingPrompt('Messi 2011 stats, all of it', blocked, '/d/decision.json')
  assert.ok(p.includes('BLOCKED — awaiting your answer to: "What would you like me to open?"'))
  assert.ok(p.includes('CONTINUE that task')) // the answer-routing guidance is present
})

test('parseDecision: explicit decisions honored; failures use failsafe', () => {
  // explicit "new" is honored even with one open task
  assert.equal(parseDecision('{"action":"new","intent":"fresh"}', 'raw', ONE).action, 'new')
  // explicit continue to a known id
  assert.deepEqual(parseDecision('{"action":"continue","targetTaskId":"t1","intent":"reply"}', 'raw', ONE),
    { action: 'continue', targetTaskId: 't1', intent: 'reply', mode: 'managed', surface: undefined })
  // timeout (null) with one recent task ⇒ continue it (the flip)
  assert.deepEqual(parseDecision(null, 'and 2015?', ONE), { action: 'continue', targetTaskId: 't1', intent: 'and 2015?', mode: 'managed' })
  // malformed with one recent task ⇒ continue it
  assert.equal(parseDecision('not json', 'x', ONE).action, 'continue')
  // null with multiple tasks ⇒ new (can't guess)
  assert.equal(parseDecision(null, 'x', TWO).action, 'new')
  // unknown id ⇒ failsafe (single ⇒ continue latest)
  assert.equal(parseDecision('{"action":"continue","targetTaskId":"zzz","intent":"x"}', 'x', ONE).targetTaskId, 't1')
  // a canonical surface is kept (lowercased); an invented one is dropped to undefined
  assert.equal(parseDecision('{"action":"new","intent":"tweet","surface":"X"}', 'r', ONE).surface, 'x')
  assert.equal(parseDecision('{"action":"new","intent":"watch","surface":"jiohotstar"}', 'r', ONE).surface, 'jiohotstar')
  assert.equal(parseDecision('{"action":"new","intent":"x","surface":"frobnicate"}', 'r', ONE).surface, undefined)
})

// A fake classifier session: when it receives the routing prompt, it writes the
// given decision to the router's decision file (mimicking the real REPL).
function fakeRouterExecutor(decisionPath: string, decision: object | null) {
  let alive = true
  const ex: AgentExecutor = {
    get alive() { return alive },
    async spawn() {},
    async isReady() {},
    writeStdin(t: string) {
      if (decision && t.includes('[Unmute router]')) {
        void fs.mkdir(path.dirname(decisionPath), { recursive: true })
          .then(() => fs.writeFile(decisionPath, JSON.stringify(decision)))
      }
    },
    write() {},
    resize() {},
    onData() {},
    kill() { alive = false },
  }
  return ex
}

test('Router.warm() spawns the session before the first route', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  let spawns = 0
  const factory = () => {
    let alive = true
    const ex: AgentExecutor = {
      get alive() { return alive },
      async spawn() { spawns++ }, async isReady() {},
      writeStdin(t: string) {
        if (t.includes('[Unmute router]')) void fs.mkdir(path.dirname(decisionPath), { recursive: true })
          .then(() => fs.writeFile(decisionPath, JSON.stringify({ action: 'new', intent: 'x' })))
      },
      write() {}, resize() {}, onData() {}, kill() { alive = false },
    }
    return ex
  }
  const router = new Router({ executorFactory: factory, baseDir, readyGraceMs: 0, submitConfirmMs: 0, decisionTimeoutMs: 1000, pollMs: 20 })
  await router.warm()
  assert.equal(spawns, 1)             // already up before any utterance
  await router.route('x', ONE)
  assert.equal(spawns, 1)             // route reused the warm session, no respawn
  router.dispose()
})

test('Router.route returns continue when the session decides so', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  const ex = fakeRouterExecutor(decisionPath, { action: 'continue', targetTaskId: 't1', intent: 'reply to it' })
  const router = new Router({ executorFactory: () => ex, baseDir, readyGraceMs: 0, submitConfirmMs: 0, decisionTimeoutMs: 2000, pollMs: 20 })
  const d = await router.route('reply to it', TASKS)
  assert.equal(d.action, 'continue')
  assert.equal(d.targetTaskId, 't1')
  assert.equal(d.intent, 'reply to it')
  router.dispose()
})

test('Router sends /clear after each decision (keeps the resident session lean)', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  const writes: string[] = []
  const factory = () => {
    let alive = true
    const ex: AgentExecutor = {
      get alive() { return alive },
      async spawn() {}, async isReady() {},
      writeStdin(t: string) {
        writes.push(t)
        if (t.includes('[Unmute router]')) void fs.mkdir(path.dirname(decisionPath), { recursive: true })
          .then(() => fs.writeFile(decisionPath, JSON.stringify({ action: 'new', intent: 'x' })))
      },
      write() {}, resize() {}, onData() {}, kill() { alive = false },
    }
    return ex
  }
  const router = new Router({ executorFactory: factory, baseDir, readyGraceMs: 0, submitConfirmMs: 0, decisionTimeoutMs: 1000, pollMs: 20 })
  await router.route('x', ONE)
  await router.settleHousekeeping() // awaits the chain's trailing housekeep
  assert.ok(writes.includes('/clear'))
  router.dispose()
})

test('Router recycles the session after recycleEvery decisions', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  let spawns = 0, kills = 0
  const factory = () => {
    let alive = true
    const ex: AgentExecutor = {
      get alive() { return alive },
      async spawn() { spawns++ }, async isReady() {},
      writeStdin(t: string) {
        if (t.includes('[Unmute router]')) void fs.mkdir(path.dirname(decisionPath), { recursive: true })
          .then(() => fs.writeFile(decisionPath, JSON.stringify({ action: 'new', intent: 'x' })))
      },
      write() {}, resize() {}, onData() {}, kill() { alive = false; kills++ },
    }
    return ex
  }
  const router = new Router({ executorFactory: factory, baseDir, readyGraceMs: 0, submitConfirmMs: 0, decisionTimeoutMs: 1000, pollMs: 20, recycleEvery: 2 })
  await router.warm()                 // spawns === 1
  await router.route('a', ONE); await router.settleHousekeeping()
  await router.route('b', ONE); await router.settleHousekeeping() // 2nd decision ⇒ recycle
  assert.equal(spawns, 2)             // one fresh session spun up
  assert.equal(kills, 1)              // old one killed
  router.dispose()
})

test('Router.route fails safe on timeout: ambiguous (2+ tasks) ⇒ NEW', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  const ex = fakeRouterExecutor(decisionPath, null) // never writes
  const router = new Router({ executorFactory: () => ex, baseDir, readyGraceMs: 0, submitConfirmMs: 0, decisionTimeoutMs: 250, pollMs: 20 })
  const d = await router.route('open my downloads folder', TWO)
  assert.equal(d.action, 'new')
  assert.equal(d.intent, 'open my downloads folder')
  router.dispose()
})

test('Router.route fails safe on timeout: ONE recent task ⇒ CONTINUE it (the flip)', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  const ex = fakeRouterExecutor(decisionPath, null) // never writes (cold-timeout)
  const router = new Router({ executorFactory: () => ex, baseDir, readyGraceMs: 0, submitConfirmMs: 0, decisionTimeoutMs: 250, pollMs: 20 })
  const d = await router.route('and what about 2015?', ONE)
  assert.equal(d.action, 'continue')
  assert.equal(d.targetTaskId, 't1')
  router.dispose()
})

// ─── surface + mode tests ─────────────────────────────────────────

test('parseDecision: surface and mode parsed correctly for new action with gmail', () => {
  const d = parseDecision('{"action":"new","intent":"scan inboxes","surface":"gmail","mode":"managed"}', 'fb', [])
  assert.equal(d.action, 'new')
  assert.equal(d.surface, 'gmail')
  assert.equal(d.mode, 'managed')
})

test('parseDecision: mode raw parsed; surface omitted when absent', () => {
  const d = parseDecision('{"action":"new","intent":"open me a coding session","mode":"raw"}', 'fb', [])
  assert.equal(d.mode, 'raw')
  assert.equal(d.surface, undefined)
})

test('parseDecision: mode defaults to managed when absent', () => {
  const d = parseDecision('{"action":"new","intent":"x"}', 'fb', [])
  assert.equal(d.mode, 'managed')
})

test('parseDecision: continue decision also carries mode and surface', () => {
  const tasks: RoutableTask[] = [{ id: 't1', intent: 'scan inboxes', state: 'running', ageSec: 10 }]
  const d = parseDecision('{"action":"continue","targetTaskId":"t1","intent":"add label","surface":"gmail","mode":"managed"}', 'fb', tasks)
  assert.equal(d.action, 'continue')
  assert.equal(d.targetTaskId, 't1')
  assert.equal(d.surface, 'gmail')
  assert.equal(d.mode, 'managed')
})

// ─── Orchestrate enrichment: species/name/project in the snapshot; kind/dir out ──

test('buildRoutingPrompt carries name, species, project, humanized age, and the known-projects list', () => {
  const tasks: RoutableTask[] = [{
    id: 's1', intent: 'work on the gating feature', name: 'Gating feature work',
    state: 'processing', kind: 'session', project: 'unmute-cloud', ageSec: 200_000,
  }]
  const p = buildRoutingPrompt('keep going on gating', tasks, '/d/decision.json',
    [{ name: 'unmute-cloud', path: '/Users/u/tools/unmute/unmute-cloud' }])
  assert.ok(p.includes('"Gating feature work"'), 'name in the task line')
  assert.ok(p.includes('PERSISTENT SESSION'), 'species called out')
  assert.ok(p.includes('project: unmute-cloud'), 'project label in the task line')
  assert.ok(p.includes('2d ago'), 'age humanized, not 200000s')
  assert.ok(p.includes('unmute-cloud → /Users/u/tools/unmute/unmute-cloud'), 'known projects offered')
  assert.ok(p.includes('"kind"'), 'JSON shape includes kind')
  // Without projects, the section disappears entirely.
  const bare = buildRoutingPrompt('x', tasks, '/d/decision.json')
  assert.ok(!bare.includes('Known project directories'))
})

test('parseDecision: kind/dir honored on new; dir only from the offered list; dir implies session', () => {
  const projects = [{ name: 'app', path: '/Users/u/tools/app' }]
  const d1 = parseDecision('{"action":"new","intent":"work on app","kind":"session","dir":"/Users/u/tools/app"}', 'r', [], projects)
  assert.equal(d1.kind, 'session')
  assert.equal(d1.dir, '/Users/u/tools/app')
  // An invented path never becomes a spawn cwd.
  const d2 = parseDecision('{"action":"new","intent":"x","dir":"/etc"}', 'r', [], projects)
  assert.equal(d2.dir, undefined)
  // dir from the list implies kind session even if the model said oneoff.
  const d3 = parseDecision('{"action":"new","intent":"x","kind":"oneoff","dir":"/Users/u/tools/app"}', 'r', [], projects)
  assert.equal(d3.kind, 'session')
  // No dir + no kind → oneoff (status quo).
  const d4 = parseDecision('{"action":"new","intent":"open mail"}', 'r', [], projects)
  assert.equal(d4.kind, 'oneoff')
  assert.equal(d4.dir, undefined)
})

test('parseDecision: alternate honored on new only when it names an offered task', () => {
  const tasks: RoutableTask[] = [{ id: 't1', intent: 'check emails', state: 'processing', ageSec: 30 }]
  const d1 = parseDecision('{"action":"new","intent":"draft a tweet","alternate":"t1"}', 'r', tasks)
  assert.equal(d1.alternate, 't1')
  const d2 = parseDecision('{"action":"new","intent":"x","alternate":"ghost"}', 'r', tasks)
  assert.equal(d2.alternate, undefined)
  // Never on continue.
  const d3 = parseDecision('{"action":"continue","targetTaskId":"t1","intent":"x","alternate":"t1"}', 'r', tasks)
  assert.equal(d3.alternate, undefined)
})

test('parseDecision: router-minted name honored on new; junk names dropped', () => {
  const d1 = parseDecision('{"action":"new","intent":"check pricing","name":"Unmute pricing check"}', 'r', [])
  assert.equal(d1.name, 'Unmute pricing check')
  const d2 = parseDecision('{"action":"new","intent":"x","name":"  \\"Quoted.\\" "}', 'r', [])
  assert.equal(d2.name, 'Quoted')
  const long = 'x'.repeat(60)
  const d3 = parseDecision(`{"action":"new","intent":"x","name":"${long}"}`, 'r', [])
  assert.equal(d3.name, undefined)
})

test('buildRoutingPrompt: recently-finished section is context-only (no ids, non-continuable framing)', () => {
  const finished: RoutableTask[] = [{ id: 'dead1', intent: 'Play Wolf by Selena Gomez on YouTube', name: 'Selena Gomez song', state: 'done', ageSec: 150 }]
  const p = buildRoutingPrompt('change the song to Charlie Puth', [], '/d/decision.json', [], finished)
  assert.ok(p.includes('Recently FINISHED'), 'section present')
  assert.ok(p.includes('Selena Gomez song'), 'finished task named for reference resolution')
  assert.ok(p.includes('SELF-CONTAINED'), 'instructs carrying context into a new intent')
  assert.ok(!p.includes('[dead1]'), 'finished ids are never offered as targets')
  // continue → a finished id is rejected at parse (not in valid targets)
  const d = parseDecision('{"action":"continue","targetTaskId":"dead1","intent":"x"}', 'x', [])
  assert.equal(d.action, 'new', 'continue into the dead falls back safely')
})

test('failsafe NEVER continues into a RUNNING task — a wrong new task is cheap, a wrong injection is destructive', () => {
  const running: RoutableTask[] = [{ id: 'r1', intent: 'devise growth strategy', state: 'processing', ageSec: 20 }]
  const d = failsafeDecision(running, 'rephrase this tweet and copy it')
  assert.equal(d.action, 'new', 'running lone task → new, never inject')
  // …but a lone task WAITING on the user is still the likely target (an answer).
  const waiting: RoutableTask[] = [{ id: 'w1', intent: 'draft email', state: 'needs-user', ageSec: 20 }]
  assert.equal(failsafeDecision(waiting, 'send it to Bob').action, 'continue')
  // and a parked finished task keeps its follow-up window.
  const parked: RoutableTask[] = [{ id: 'p1', intent: 'check emails', state: 'done', ageSec: 60 }]
  assert.equal(failsafeDecision(parked, 'reply to the second one').action, 'continue')
})

// ─── Consent policy: cold working sessions are focus-only ─────────────────────

test('cold sessions render as non-targetable context; continue into one is REJECTED; alternate to one is allowed', () => {
  const cold: RoutableTask[] = [{
    id: 'sess1', intent: 'devise growth strategy', name: 'Growth strategy',
    state: 'processing', kind: 'session', ageSec: 7200,
  }]
  const p = buildRoutingPrompt('rephrase this tweet', [], '/d/decision.json', [], [], cold)
  assert.ok(p.includes('may NOT'), 'prompt marks cold sessions non-targetable')
  assert.ok(p.includes('Growth strategy'), 'cold session still visible as context')
  assert.ok(p.includes('one-tap offer'), 'offer path explained')

  // Layer 2 enforcement: model disobeys and targets the cold session → rejected → NEW.
  const d1 = parseDecision('{"action":"continue","targetTaskId":"sess1","intent":"rephrase tweet"}', 'r', [], [], cold)
  assert.equal(d1.action, 'new', 'continue into a cold session is rejected at parse')
  assert.equal(d1.targetTaskId, undefined)

  // alternate → cold session is the CONSENT path (one-tap offer) — allowed.
  const d2 = parseDecision('{"action":"new","intent":"rephrase tweet","alternate":"sess1"}', 'r', [], [], cold)
  assert.equal(d2.action, 'new')
  assert.equal(d2.alternate, 'sess1')

  // targetable tasks keep working exactly as before.
  const hot: RoutableTask[] = [{ id: 'hot1', intent: 'draft doc', state: 'processing', kind: 'session', ageSec: 30 }]
  const d3 = parseDecision('{"action":"continue","targetTaskId":"hot1","intent":"add a section"}', 'r', hot, [], cold)
  assert.equal(d3.action, 'continue')
  assert.equal(d3.targetTaskId, 'hot1')
})
