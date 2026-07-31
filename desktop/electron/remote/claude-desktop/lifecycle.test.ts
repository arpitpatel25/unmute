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
    completedTurns: 0, createdAt: 0, lastActivityAt: Date.now(), lastFocusedAt: 0, archived: false,
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
    /** Newest lastFocusedAt = the conversation Claude Desktop has open. */
    focused: async () => {
      let best: ClaudeDesktopTask | null = null
      for (const t of tasks) if (t.lastFocusedAt > 0 && (!best || t.lastFocusedAt > best.lastFocusedAt)) best = t
      return best
    },
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

test('the FIRST poll seeds the baseline — an old chat must not light up as working', async () => {
  // Caught against the real store: every one of 8 adopted conversations, all
  // finished days earlier, showed `processing` because the first read compared
  // updatedAt against a default of 0 and called it growth.
  const base = await tmp()
  const d = fakeDriver({ tasks: [{}], snapshots: [{ updatedAt: 1_700_000_000_000, lastAgentMessage: 'done long ago' }] })
  const m = await makeManager(d, base)
  const [id] = await m.adoptClaudeDesktop()
  await poll(m, id)
  assert.equal(m.get(id)!.state, 'ready')
  m.killAll(); m.stopMaintenance()
})

test('a growing transcript moves the card to processing', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{}], snapshots: [
    { updatedAt: 5000, turns: [{ role: 'user', text: 'hi' }] },
    { updatedAt: 9000, turns: [{ role: 'user', text: 'hi' }] },   // grew
  ] })
  const m = await makeManager(d, base)
  const [id] = await m.adoptClaudeDesktop()
  await poll(m, id)                       // seeds the baseline only
  await pollForced(m, id)                 // now it has genuinely grown
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
  await poll(m, id)                       // seeds baseline -> stays ready
  // Forced = the tick that actually reads. A settled card is decimated 10:1,
  // so in production this is either every 10th tick or a watcher wake.
  await pollForced(m, id)                 // no growth, has spoken -> ready
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
    { updatedAt: 1000, lastAgentMessage: 'done' },   // seeds the baseline
    { updatedAt: 1000, lastAgentMessage: 'done' },   // quiet -> stays ready
    { updatedAt: 9000, lastAgentMessage: 'done' },   // user replied inside Claude
  ] })
  const m = await makeManager(d, base)
  const [id] = await m.adoptClaudeDesktop()
  await poll(m, id)                       // seeds the baseline
  await pollForced(m, id)                 // quiet -> still ready
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

// ── blocked: the state only the live UI can supply ────────────────────────

/** A fake AX reader. `consent` present ⇒ a prompt is on screen. */
function fakeAx(script: { treeAlive?: boolean; consent?: { question: string } | null; rows?: Array<{ title: string; status: string; id: number }> } = {}) {
  const alive = script.treeAlive ?? true
  // readState/readSidebarRows run for real over these nodes, so the fake
  // exercises the actual parsers rather than stubbing their answers.
  const nodes: Array<{ id: number; depth: number; role: string; label: string; actions: string[] }> = []
  let id = 1
  if (alive) nodes.push({ id: id++, depth: 1, role: 'AXWebArea', label: '', actions: [] })
  for (const r of script.rows ?? []) {
    nodes.push({ id: id++, depth: 19, role: 'AXButton', label: `${r.status} ${r.title}`.trim(), actions: ['AXPress'] })
  }
  if (script.consent) {
    nodes.push({ id: id++, depth: 20, role: 'AXStaticText', label: script.consent.question, actions: [] })
    nodes.push({ id: id++, depth: 21, role: 'AXButton', label: 'Deny 1', actions: ['AXPress'] })
    nodes.push({ id: id++, depth: 21, role: 'AXButton', label: 'Allow once 3', actions: ['AXPress'] })
  }
  return { nodes: async () => nodes }
}

async function managerWithAx(driver: unknown, ax: unknown, baseDir: string) {
  return new TaskManager({
    executorFactory: () => { throw new Error('no executor for a driven backend') },
    claudeDesktopDriver: driver as never,
    claudeDesktopAx: ax as never,
    baseDir, userKey: 'test', pollMs: 10_000,
  })
}

test('a visible prompt on the FOCUSED conversation blocks that card', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'Fix login', lastFocusedAt: Date.now() }], snapshots: [{ updatedAt: 5000 }] })
  const ax = fakeAx({ consent: { question: 'Allow Claude to write a file?' } })
  const m = await managerWithAx(d, ax, base)
  const [id] = await m.adoptClaudeDesktop()
  await pollForced(m, id)
  assert.equal(m.get(id)!.state, 'needs-user')
  m.killAll(); m.stopMaintenance()
})

test('the prompt is NOT attributed to an unfocused card', async () => {
  // Only one conversation is addressable, so a prompt can only belong to the
  // focused one. Lighting up the wrong card is worse than lighting up none.
  const base = await tmp()
  const d = fakeDriver({
    tasks: [{ title: 'Not focused', lastFocusedAt: 0 }, { title: 'Focused', lastFocusedAt: Date.now() }],
    snapshots: [{ updatedAt: 5000 }],
  })
  const ax = fakeAx({ consent: { question: 'Allow Claude to run this?' } })
  const m = await managerWithAx(d, ax, base)
  const ids = await m.adoptClaudeDesktop()
  const unfocused = ids.map((i) => m.get(i)!).find((t) => t.name === 'Not focused')!
  await pollForced(m, unfocused.id)
  assert.notEqual(m.get(unfocused.id)!.state, 'needs-user')
  m.killAll(); m.stopMaintenance()
})

test('a dead tree never blocks — no information is not a prompt', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'Fix login', lastFocusedAt: Date.now() }], snapshots: [{ updatedAt: 5000 }] })
  const ax = fakeAx({ treeAlive: false, consent: { question: 'Allow Claude to write?' } })
  const m = await managerWithAx(d, ax, base)
  const [id] = await m.adoptClaudeDesktop()
  await pollForced(m, id)
  assert.notEqual(m.get(id)!.state, 'needs-user')
  m.killAll(); m.stopMaintenance()
})

test('answering the prompt anywhere un-blocks the card', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'Fix login', lastFocusedAt: Date.now() }], snapshots: [{ updatedAt: 5000 }] })
  let consent: { question: string } | null = { question: 'Allow Claude to write a file?' }
  const ax = { nodes: async () => fakeAx({ consent }).nodes() }
  const m = await managerWithAx(d, ax, base)
  const [id] = await m.adoptClaudeDesktop()
  await pollForced(m, id)
  assert.equal(m.get(id)!.state, 'needs-user')
  consent = null                                  // answered, in Unmute or in the app
  ;(m as unknown as { claudeAxCache: unknown }).claudeAxCache = null   // expire the shared read
  await pollForced(m, id)
  assert.notEqual(m.get(id)!.state, 'needs-user')
  m.killAll(); m.stopMaintenance()
})

test("the app's own status word is shown verbatim, not mapped to a state", async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'Fix login', lastFocusedAt: Date.now() }], snapshots: [{ updatedAt: 5000 }] })
  const ax = fakeAx({ rows: [{ title: 'Fix login', status: 'Idle', id: 1 }] })
  const m = await managerWithAx(d, ax, base)
  const [id] = await m.adoptClaudeDesktop()
  await pollForced(m, id)
  assert.equal(m.get(id)!.claudeStatusChip, 'Idle')
  m.killAll(); m.stopMaintenance()
})

test('no AX reader configured ⇒ cards still work from disk', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'Fix login' }], snapshots: [{ updatedAt: 5000, lastAgentMessage: 'hi' }] })
  const m = await makeManager(d, base)          // no ax
  const [id] = await m.adoptClaudeDesktop()
  await pollForced(m, id)
  assert.equal(m.get(id)!.state, 'ready')
  m.killAll(); m.stopMaintenance()
})
