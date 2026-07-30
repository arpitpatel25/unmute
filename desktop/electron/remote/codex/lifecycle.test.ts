import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskManager } from '../task-manager'

// A fake Codex backend: records what the manager asks of it and returns
// scripted snapshots, so the whole lifecycle can be driven without a Codex app.
function fakeDriver(script: { states?: Array<{ state: string; lastAgentMessage?: string | null; everCompleted?: boolean }> } = {}) {
  const calls: Array<{ fn: string; args: unknown[] }> = []
  let i = 0
  return {
    calls,
    createTask: async (intent: string, opts: { project?: string | null }) => {
      calls.push({ fn: 'createTask', args: [intent, opts] })
      return { ok: true as const, threadId: 'thread-123' }
    },
    /** Overridable so a test can make a delivery fail without failing the task. */
    sendResult: { ok: true } as { ok: boolean; reason?: string },
    send: async function (this: { sendResult: { ok: boolean; reason?: string } }, threadId: string, text: string) {
      calls.push({ fn: 'send', args: [threadId, text] })
      return this.sendResult as { ok: true } | { ok: false; reason: string }
    },
    openThread: async () => true,
    snapshot: async () => {
      const s = script.states?.[Math.min(i++, (script.states?.length ?? 1) - 1)]
        ?? { state: 'processing' }
      return { turns: [], updatedAt: Date.now(), turnsStarted: 1, everCompleted: false, lastAgentMessage: null, ...s } as never
    },
  }
}

async function makeManager(driver: unknown, baseDir: string, extra: Record<string, unknown> = {}) {
  return new TaskManager({
    ...extra,
    executorFactory: () => { throw new Error('executorFactory must NOT be called for a codex-desktop task') },
    codexDriver: driver as never,
    baseDir,
    userKey: 'test',
    pollMs: 10_000, // we drive polling manually
    trustAcceptMs: 0,
  })
}

const tmp = async () => fs.mkdtemp(join(tmpdir(), 'unmute-codex-'))

test('a codex-desktop dispatch never touches the executor factory', async () => {
  // The whole point of the fork: no PTY, no status file, no contract. The
  // executorFactory above throws, so reaching it fails the test loudly.
  const base = await tmp()
  const d = fakeDriver()
  const m = await makeManager(d, base)
  const id = await m.dispatch('fix the login bug', { agent: 'codex-desktop', project: 'unmute' })
  const t = m.get(id)!
  assert.equal(t.agent, 'codex-desktop')
  assert.equal(t.codexThreadId, 'thread-123')
  assert.equal(t.codexProject, 'unmute')
  assert.equal(t.state, 'processing')
  // Created project-scoped, with the user's words verbatim — and carrying the
  // user's permission setting, so the Codex composer is raised to the same
  // level --dangerously-skip-permissions would give a Claude task.
  assert.deepEqual(d.calls[0], {
    fn: 'createTask',
    args: ['fix the login bug', { project: 'unmute', permissionMode: 'ask' }],
  })
  m.killAll(); m.stopMaintenance()
})

test('a failed create does NOT leave a card claiming work that never started', async () => {
  const base = await tmp()
  const d = { ...fakeDriver(), createTask: async () => ({ ok: false as const, reason: 'not-armed' as const }) }
  const m = await makeManager(d, base)
  await assert.rejects(
    () => m.dispatch('do something', { agent: 'codex-desktop' }),
    /CODEX_UNAVAILABLE: not-armed/,
  )
  assert.equal(m.list().length, 0)
  m.killAll(); m.stopMaintenance()
})

test('dispatch fails fast when no codex backend is configured', async () => {
  // Silently falling back to Claude would run the task in an app the user did
  // not choose — worse than an error.
  const base = await tmp()
  const m = new TaskManager({
    executorFactory: () => { throw new Error('should not spawn') },
    baseDir: base, userKey: 'test', pollMs: 10_000, trustAcceptMs: 0,
  })
  await assert.rejects(() => m.dispatch('x', { agent: 'codex-desktop' }), /CODEX_UNAVAILABLE: not-configured/)
  m.killAll(); m.stopMaintenance()
})

test('answering a codex task is just its next turn (no PTY needed)', async () => {
  const base = await tmp()
  const d = fakeDriver()
  const m = await makeManager(d, base)
  const id = await m.dispatch('start', { agent: 'codex-desktop' })
  m.answer(id, 'use the other approach')
  const sent = d.calls.find((c) => c.fn === 'send')
  assert.ok(sent, 'answer must reach the Codex thread')
  assert.deepEqual(sent!.args, ['thread-123', 'use the other approach'])
  m.killAll(); m.stopMaintenance()
})

test('a follow-up sends into the same thread', async () => {
  const base = await tmp()
  const d = fakeDriver()
  const m = await makeManager(d, base)
  const id = await m.dispatch('start', { agent: 'codex-desktop' })
  assert.equal(m.followUp(id, 'and also add tests'), true)
  const sent = d.calls.filter((c) => c.fn === 'send')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].args, ['thread-123', 'and also add tests'])
  m.killAll(); m.stopMaintenance()
})

test('meta.json records the backend so the task survives a restart', async () => {
  const base = await tmp()
  const d = fakeDriver()
  const m = await makeManager(d, base)
  const id = await m.dispatch('persisted work', { agent: 'codex-desktop', project: 'unmute' })
  const meta = JSON.parse(await fs.readFile(join(base, 'test', id, 'meta.json'), 'utf8'))
  assert.equal(meta.agent, 'codex-desktop')
  assert.equal(meta.codexThreadId, 'thread-123')
  assert.equal(meta.codexProject, 'unmute')
  m.killAll(); m.stopMaintenance()

  // A fresh manager over the same dir must restore it as LIVE, not as the
  // "interrupted by restart" a PTY task becomes — the Codex thread outlived us.
  const m2 = await makeManager(fakeDriver(), base)
  await m2.rehydrate()
  const restored = m2.get(id)
  assert.ok(restored, 'codex task must rehydrate')
  assert.equal(restored!.agent, 'codex-desktop')
  assert.equal(restored!.codexThreadId, 'thread-123')
  assert.notEqual(restored!.state, 'failed')
  m2.killAll(); m2.stopMaintenance()
})

test('a failed SEND does not become a failed task', async () => {
  // Field report: one missed delivery marked the task failed, and it then sat in
  // the attention queue for hours. The Codex thread was untouched and healthy —
  // only our attempt to type into it missed. Marking the work failed was wrong,
  // and polling stops on `failed`, so it could never correct itself.
  const base = await tmp()
  const d = fakeDriver()
  d.sendResult = { ok: false, reason: 'thread-not-found' }
  const m = await makeManager(d, base)
  const id = await m.dispatch('open the video', { agent: 'codex-desktop' })
  const before = m.get(id)!.state

  m.answer(id, 'also check the description')
  await new Promise((r) => setTimeout(r, 30))

  const t = m.get(id)!
  assert.notEqual(t.state, 'failed', 'the task must not be settled by a delivery miss')
  assert.equal(t.state, before, 'it goes back exactly where it was')
  assert.match(t.deliveryError ?? '', /Could not find that chat/, 'and says what went wrong')
  m.killAll(); m.stopMaintenance()
})

test('a later successful send clears the delivery error', async () => {
  const base = await tmp()
  const d = fakeDriver()
  d.sendResult = { ok: false, reason: 'thread-not-found' }
  const m = await makeManager(d, base)
  const id = await m.dispatch('open the video', { agent: 'codex-desktop' })
  m.answer(id, 'first try')
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(m.get(id)!.deliveryError)

  d.sendResult = { ok: true }
  m.answer(id, 'second try')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(m.get(id)!.deliveryError, undefined)
  m.killAll(); m.stopMaintenance()
})

test('a send shows as in flight, then stops when it lands', async () => {
  // Sending is a round-trip through another app's window. Silence for a second
  // reads as nothing having happened.
  const base = await tmp()
  const d = fakeDriver()
  let release: (() => void) | null = null
  d.send = async function () {
    await new Promise<void>((r) => { release = r })
    return { ok: true as const }
  } as never
  const m = await makeManager(d, base)
  const id = await m.dispatch('open the video', { agent: 'codex-desktop' })
  m.answer(id, 'and the description')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(m.get(id)!.sending, true)
  release!()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(m.get(id)!.sending, false)
  m.killAll(); m.stopMaintenance()
})

test('the model choice reaches Codex, and is recorded on the task', async () => {
  const base = await tmp()
  const d = fakeDriver()
  const m = await makeManager(d, base, {
    codexReasoning: () => ({ model: '5.6 Luna', effort: 'Ultra' }),
  })
  const id = await m.dispatch('do it', { agent: 'codex-desktop' })
  const args = d.calls[0].args[1] as Record<string, unknown>
  assert.equal(args.model, '5.6 Luna')
  assert.equal(args.effort, 'Ultra')
  assert.equal(m.get(id)!.codexModelLabel, '5.6 Luna Ultra', 'so the composer can say what it runs on')
  m.killAll(); m.stopMaintenance()
})

test('a relaunch does NOT replay an old completion as if it just happened', async () => {
  // THE BUG: rehydrate restored `processing`, the first poll re-derived `ready`
  // and transition() stamped updatedAt = now — so a thread finished yesterday
  // looked zero seconds old, sailed past the staleness guard, and the notch
  // announced "Ready: …" on every single launch, forever.
  const base = await tmp()
  const finishedAt = Date.now() - 14 * 60 * 60 * 1000   // 14h ago
  const d = fakeDriver()
  d.snapshot = async () => ({
    state: 'ready', lastAgentMessage: 'done', turns: [],
    updatedAt: finishedAt, turnsStarted: 1, everCompleted: true,
  }) as never

  const m = await makeManager(d, base)
  const id = await m.dispatch('open the video', { agent: 'codex-desktop' })
  await (m as unknown as { pollCodexDesktop(id: string): Promise<void> }).pollCodexDesktop(id)

  const t = m.get(id)!
  assert.equal(t.state, 'ready')
  assert.ok(Date.now() - t.updatedAt > 13 * 60 * 60 * 1000,
    'the task carries WHEN IT FINISHED, not when we noticed')
  m.killAll(); m.stopMaintenance()
})

test('the observed state is written to meta.json, so a restart restores it', async () => {
  const base = await tmp()
  const d = fakeDriver()
  d.snapshot = async () => ({
    state: 'ready', lastAgentMessage: 'done', turns: [],
    updatedAt: Date.now() - 9 * 60 * 60 * 1000, turnsStarted: 1, everCompleted: true,
  }) as never
  const m = await makeManager(d, base)
  const id = await m.dispatch('open the video', { agent: 'codex-desktop' })
  await (m as unknown as { pollCodexDesktop(id: string): Promise<void> }).pollCodexDesktop(id)
  await new Promise((r) => setTimeout(r, 30))

  const meta = JSON.parse(await fs.readFile(join(base, 'test', id, 'meta.json'), 'utf8'))
  assert.equal(meta.state, 'ready', 'rehydrate has something real to restore')
  assert.ok(meta.updatedAt < Date.now() - 8 * 60 * 60 * 1000, 'and the honest timestamp with it')
  m.killAll(); m.stopMaintenance()
})

// ── the stuck ⇄ processing oscillation (observed 2026-07-30) ─────────────────
// A Computer Use consent froze a turn mid-exec. The rollout stopped growing, so
// the staleness rule said "stuck"; the same rollout still showed an unfinished
// turn, so the recovery rule said "processing". They alternated once a SECOND —
// logs show stuck-recovered/task-stuck at 1s intervals — and the notch strobed
// red/green. Neither rule advanced the heartbeat, so it never settled.
//
// The clock is injected so a turn can be frozen for minutes without the test
// sleeping; `updatedAt` is what Codex wrote, `now()` is wall time.

async function frozenTurn(opts: { pending: number; grows?: boolean }) {
  const base = await tmp()
  let now = Date.now()
  let wrote = now                       // newest rollout timestamp
  const d = fakeDriver()
  d.snapshot = async () => ({
    state: 'processing', lastAgentMessage: null, turns: [],
    updatedAt: opts.grows ? (wrote += 30_000) : wrote,
    turnsStarted: 1, everCompleted: false,
    pendingToolCalls: opts.pending, pendingToolName: opts.pending ? 'exec' : null,
  }) as never
  const m = await makeManager(d, base, {
    codexBlockedMs: 45_000, staleMs: 60_000, now: () => now,
  })
  const id = await m.dispatch('open whatsapp', { agent: 'codex-desktop' })
  const poll = (m as unknown as { pollCodexDesktop(id: string): Promise<void> }).pollCodexDesktop.bind(m)
  await poll(id)                        // first look: establishes the baseline
  return { m, id, poll, advance: (ms: number) => { now += ms } }
}

test('a frozen mid-tool-call turn settles on needs-user, it does NOT oscillate', async () => {
  const { m, id, poll, advance } = await frozenTurn({ pending: 1 })
  try {
    advance(5 * 60_000)                 // five minutes with nothing written
    const seen: string[] = []
    for (let i = 0; i < 6; i++) { await poll(id); seen.push(m.get(id)!.state) }
    assert.deepEqual([...new Set(seen)], ['needs-user'],
      `state must be stable across polls, saw: ${seen.join(' -> ')}`)
  } finally { m.killAll(); m.stopMaintenance() }
})

test('a turn that is still GROWING is never called blocked', async () => {
  // The discriminator is "did the rollout advance", not "is a call open" — a
  // slow build has an open call too and must keep reading as processing.
  const { m, id, poll, advance } = await frozenTurn({ pending: 1, grows: true })
  try {
    for (let i = 0; i < 4; i++) { advance(20_000); await poll(id) }
    assert.equal(m.get(id)!.state, 'processing')
  } finally { m.killAll(); m.stopMaintenance() }
})

test('a frozen turn with NO open call is stuck, not blocked', async () => {
  // Nothing to wait on => the genuine "something went wrong" backstop, which
  // must stay reachable.
  const { m, id, poll, advance } = await frozenTurn({ pending: 0 })
  try {
    advance(5 * 60_000)
    await poll(id); await poll(id)
    assert.equal(m.get(id)!.state, 'stuck')
  } finally { m.killAll(); m.stopMaintenance() }
})
