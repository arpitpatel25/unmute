import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskManager } from '../task-manager'
import type { ClaudeDesktopTask, ClaudeSnapshot, ClaudeTaskView } from './driver'

// A fake Claude Desktop backend. Unlike the Codex fake this one has no
// createTask: this backend does not dispatch, it ADOPTS what the user already
// started in the app.
function fakeDriver(script: {
  tasks?: Partial<ClaudeDesktopTask>[]
  snapshots?: Partial<ClaudeSnapshot>[]
} = {}) {
  const calls: string[] = []
  let i = 0
  const tasks: ClaudeDesktopTask[] = (script.tasks ?? []).map((t, n) => ({
    sessionId: `local_s${n}`, cliSessionId: `cli${n}`, title: null, model: null,
    cwd: '/w', originCwd: null, worktreePath: null, permissionMode: null,
    completedTurns: 0, createdAt: 0, lastActivityAt: Date.now(), archived: false,
    transcriptUnavailable: false, ...t,
  }))
  return {
    calls,
    /** Simulate the user renaming a chat inside Claude Desktop. */
    rename: (id: string, title: string) => {
      const t = tasks.find((x) => x.sessionId === id)
      if (t) t.title = title
    },
    list: async () => { calls.push('list'); return tasks },
    find: async (id: string) => tasks.find((t) => t.sessionId === id) ?? null,
    snapshot: async (id: string): Promise<ClaudeTaskView | null> => {
      calls.push('snapshot')
      const task = tasks.find((t) => t.sessionId === id)
      if (!task) return null
      const s = script.snapshots?.[Math.min(i++, (script.snapshots?.length ?? 1) - 1)] ?? {}
      return {
        task,
        snapshot: {
          lastAgentMessage: null, turns: [], updatedAt: 0, userMessages: 0,
          pendingToolCalls: 0, pendingToolName: null, ...s,
        },
      }
    },
    watch: async () => () => {},
    availability: async () => ({ ok: true }),
    isInstalled: async () => true,
  }
}

async function makeManager(driver: unknown, baseDir: string, now?: () => number) {
  return new TaskManager({
    executorFactory: () => { throw new Error('executorFactory must NOT be called for a driven backend') },
    claudeDesktopDriver: driver as never,
    baseDir,
    userKey: 'test',
    pollMs: 10_000,   // polling driven manually
    ...(now ? { now } : {}),
  })
}

const tmp = async () => fs.mkdtemp(join(tmpdir(), 'unmute-cds-'))
const poll = (m: TaskManager, id: string) =>
  (m as unknown as { pollClaudeDesktop(i: string, f?: boolean): Promise<void> }).pollClaudeDesktop(id)
const pollForced = (m: TaskManager, id: string) =>
  (m as unknown as { pollClaudeDesktop(i: string, f?: boolean): Promise<void> }).pollClaudeDesktop(id, true)

// ── adoption ──────────────────────────────────────────────────────────────

test('adopts the user existing conversations — this backend never dispatches', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'Fix login' }] })
  const m = await makeManager(d, base)
  const ids = await m.adoptClaudeDesktop()
  assert.equal(ids.length, 1)
  const t = m.get(ids[0])!
  assert.equal(t.agent, 'claude-code-desktop')
  assert.equal(t.claudeDesktopSessionId, 'local_s0')
  assert.equal(t.name, 'Fix login')
  m.killAll(); m.stopMaintenance()
})

test('adopted as a SESSION so the reaper never deletes a live chat', async () => {
  const base = await tmp()
  const m = await makeManager(fakeDriver({ tasks: [{}] }), base)
  const [id] = await m.adoptClaudeDesktop()
  assert.equal(m.get(id)!.kind, 'session')
  m.killAll(); m.stopMaintenance()
})

test('adopted READY, not processing — a chat from last week is not "working"', async () => {
  const base = await tmp()
  const m = await makeManager(fakeDriver({ tasks: [{}] }), base)
  const [id] = await m.adoptClaudeDesktop()
  assert.equal(m.get(id)!.state, 'ready')
  m.killAll(); m.stopMaintenance()
})

test('adoption is idempotent — a second sweep must not double a card', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{}] })
  const m = await makeManager(d, base)
  assert.equal((await m.adoptClaudeDesktop()).length, 1)
  assert.equal((await m.adoptClaudeDesktop()).length, 0)
  assert.equal(m.list().filter((t) => t.agent === 'claude-code-desktop').length, 1)
  m.killAll(); m.stopMaintenance()
})

test('archived tasks are left alone — the user already filed them away', async () => {
  const base = await tmp()
  const m = await makeManager(fakeDriver({ tasks: [{ archived: true }] }), base)
  assert.deepEqual(await m.adoptClaudeDesktop(), [])
  m.killAll(); m.stopMaintenance()
})

test('tasks older than the window are skipped — the wall is not an archive', async () => {
  const base = await tmp()
  // A realistic clock: `now - 48h` must stay POSITIVE, because a non-positive
  // lastActivityAt means "unknown" and is deliberately adopted rather than aged out.
  const now = Date.now()
  const m = await makeManager(
    fakeDriver({ tasks: [{ lastActivityAt: now - 48 * 3600_000 }] }), base, () => now)
  assert.deepEqual(await m.adoptClaudeDesktop({ windowMs: 24 * 3600_000 }), [])
  m.killAll(); m.stopMaintenance()
})

test('the cap bounds one sweep', async () => {
  const base = await tmp()
  const m = await makeManager(
    fakeDriver({ tasks: [{}, {}, {}, {}, {}] }), base)
  assert.equal((await m.adoptClaudeDesktop({ cap: 2 })).length, 2)
  m.killAll(); m.stopMaintenance()
})

test('an unreadable store yields nothing rather than throwing into the sweep', async () => {
  const base = await tmp()
  const d = fakeDriver()
  d.list = async () => { throw new Error('EACCES') }
  const m = await makeManager(d, base)
  assert.deepEqual(await m.adoptClaudeDesktop(), [])
  m.killAll(); m.stopMaintenance()
})

test('no driver configured ⇒ no adoption, and no crash', async () => {
  const base = await tmp()
  const m = new TaskManager({ executorFactory: () => { throw new Error('nope') }, baseDir: base, userKey: 't', pollMs: 10_000 })
  assert.deepEqual(await m.adoptClaudeDesktop(), [])
  m.killAll(); m.stopMaintenance()
})

// ── polling ───────────────────────────────────────────────────────────────

test('a growing transcript moves the card to processing', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{}], snapshots: [{ updatedAt: 5000, turns: [{ role: 'user', text: 'hi' }] }] })
  const m = await makeManager(d, base)
  const [id] = await m.adoptClaudeDesktop()
  await poll(m, id)
  assert.equal(m.get(id)!.state, 'processing')
  m.killAll(); m.stopMaintenance()
})

test('quiet AND it has spoken ⇒ ready', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{}], snapshots: [
    { updatedAt: 5000, lastAgentMessage: 'working' },
    { updatedAt: 5000, lastAgentMessage: 'all done' },   // same timestamp = no growth
  ] })
  const m = await makeManager(d, base)
  const [id] = await m.adoptClaudeDesktop()
  await poll(m, id)                       // grew -> processing
  assert.equal(m.get(id)!.state, 'processing')
  await poll(m, id)                       // no growth, has spoken -> ready
  assert.equal(m.get(id)!.state, 'ready')
  assert.equal(m.get(id)!.threadContext, 'all done')
  m.killAll(); m.stopMaintenance()
})

test('an unmatched tool call is NOT reported as blocked', async () => {
  // A pending call is what a permission prompt looks like on disk — and also
  // what a slow build looks like. Guessing here is what produced the Codex
  // stuck/processing strobe. The real signal comes from the AX tree.
  const base = await tmp()
  const d = fakeDriver({ tasks: [{}], snapshots: [
    { updatedAt: 5000, lastAgentMessage: 'x', pendingToolCalls: 1, pendingToolName: 'Bash' },
    { updatedAt: 5000, lastAgentMessage: 'x', pendingToolCalls: 1, pendingToolName: 'Bash' },
  ] })
  const m = await makeManager(d, base)
  const [id] = await m.adoptClaudeDesktop()
  await poll(m, id)
  await poll(m, id)
  assert.notEqual(m.get(id)!.state, 'needs-user')
  assert.notEqual(m.get(id)!.state, 'stuck')
  m.killAll(); m.stopMaintenance()
})

test('a new turn re-opens a settled card — the chat outlives our card', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{}], snapshots: [
    { updatedAt: 1000, lastAgentMessage: 'done' },
    { updatedAt: 1000, lastAgentMessage: 'done' },   // settles to ready
    { updatedAt: 9000, lastAgentMessage: 'done' },   // user replied inside Claude
  ] })
  const m = await makeManager(d, base)
  const [id] = await m.adoptClaudeDesktop()
  await poll(m, id); await poll(m, id)
  assert.equal(m.get(id)!.state, 'ready')
  // The watcher path: proof the file moved, so it must not be decimated.
  await pollForced(m, id)
  assert.equal(m.get(id)!.state, 'processing')
  m.killAll(); m.stopMaintenance()
})

test('a task deleted inside Claude Desktop keeps its last state, not an invented failure', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{}] })
  const m = await makeManager(d, base)
  const [id] = await m.adoptClaudeDesktop()
  d.snapshot = async () => null            // vanished from the store
  await poll(m, id)
  assert.equal(m.get(id)!.state, 'ready')
  m.killAll(); m.stopMaintenance()
})

test('the app own title wins — the two lists have to line up', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'Old name' }], snapshots: [{ updatedAt: 1 }] })
  const m = await makeManager(d, base)
  const [id] = await m.adoptClaudeDesktop()
  // Rename it in the app: mutate the record snapshot() actually serves.
  d.rename('local_s0', 'Renamed in the app')
  await poll(m, id)
  assert.equal(m.get(id)!.name, 'Renamed in the app')
  m.killAll(); m.stopMaintenance()
})

test('the conversation is kept current — it is this backend terminal', async () => {
  const base = await tmp()
  const turns = [
    { role: 'tool' as const, text: 'Bash', title: 'Bash', code: '{}', output: 'ok', ok: true },
    { role: 'assistant' as const, text: 'Finished.' },
  ]
  const d = fakeDriver({ tasks: [{}], snapshots: [{ updatedAt: 5000, turns, lastAgentMessage: 'Finished.' }] })
  const m = await makeManager(d, base)
  const [id] = await m.adoptClaudeDesktop()
  await poll(m, id)
  assert.deepEqual(m.get(id)!.conversation, turns)
  m.killAll(); m.stopMaintenance()
})
