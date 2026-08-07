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
    /** Simulate Claude Desktop writing a NEW conversation into the store. */
    push: (t: Record<string, unknown>) => {
      tasks.push({
        sessionId: `local_new${tasks.length}`, cliSessionId: `cliN${tasks.length}`, title: null,
        model: null, cwd: '/w', originCwd: null, worktreePath: null, permissionMode: null,
        completedTurns: 0, createdAt: 0, lastActivityAt: Date.now(), lastFocusedAt: 0,
        archived: false, transcriptUnavailable: false, ...t,
      } as ClaudeDesktopTask)
    },
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

test('adopted FINISHED, not processing — a chat from last week is not "working"', async () => {
  const base = await tmp()
  const m = await makeManager(fakeDriver({ tasks: [{}] }), base)
  const [id] = await m.adoptClaudeDesktop()
  assert.equal(m.get(id)!.state, 'done')
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
  assert.equal(m.get(id)!.state, 'done')
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

test('quiet AND it has spoken ⇒ finished (the ball is back with you)', async () => {
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
  assert.equal(m.get(id)!.state, 'done')
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
  assert.equal(m.get(id)!.state, 'done')
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
  assert.equal(m.get(id)!.state, 'done')
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
  assert.equal(m.get(id)!.state, 'done')
  m.killAll(); m.stopMaintenance()
})

// ── answering from Unmute ─────────────────────────────────────────────────

function fakeActuator(ok = true) {
  const answered: string[] = []
  return {
    answered,
    answerConsent: async (_c: unknown, label: string) => {
      answered.push(label)
      return ok ? { ok: true } : { ok: false, reason: 'bridge-failed' as const }
    },
    send: async () => ({ ok: true }),
  }
}

async function managerFull(driver: unknown, ax: unknown, act: unknown, baseDir: string) {
  return new TaskManager({
    executorFactory: () => { throw new Error('no executor') },
    claudeDesktopDriver: driver as never,
    claudeDesktopAx: ax as never,
    claudeActuator: act as never,
    baseDir, userKey: 'test', pollMs: 10_000,
  })
}

test('the consent reaches the card, so the user can see what is being asked', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'Fix login', lastFocusedAt: Date.now() }], snapshots: [{ updatedAt: 5000 }] })
  const ax = fakeAx({ consent: { question: 'Allow Claude to write a file?' } })
  const m = await managerWithAx(d, ax, base)
  const [id] = await m.adoptClaudeDesktop()
  await pollForced(m, id)
  const t = m.get(id)!
  assert.equal(t.claudeConsent?.question, 'Allow Claude to write a file?')
  assert.deepEqual(t.claudeConsent?.options, ['Deny 1', 'Allow once 3'])
  m.killAll(); m.stopMaintenance()
})

test('answering sends the LABEL the user saw, not an index', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'Fix login', lastFocusedAt: Date.now() }], snapshots: [{ updatedAt: 5000 }] })
  const ax = fakeAx({ consent: { question: 'Allow Claude to write a file?' } })
  const act = fakeActuator()
  const m = await managerFull(d, ax, act, base)
  const [id] = await m.adoptClaudeDesktop()
  await pollForced(m, id)
  const r = await m.answerClaudeDesktop(id, 'Deny 1')
  assert.equal(r.ok, true)
  assert.deepEqual(act.answered, ['Deny 1'])
  assert.equal(m.get(id)!.claudeConsent, undefined)
  m.killAll(); m.stopMaintenance()
})

test('a prompt already answered IN THE APP is refused, not typed at', async () => {
  // Typing a digit at a prompt that is gone lands in the composer as text.
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'Fix login', lastFocusedAt: Date.now() }], snapshots: [{ updatedAt: 5000 }] })
  let consent: { question: string } | null = { question: 'Allow Claude to write?' }
  const ax = { nodes: async () => fakeAx({ consent }).nodes() }
  const act = fakeActuator()
  const m = await managerFull(d, ax, act, base)
  const [id] = await m.adoptClaudeDesktop()
  await pollForced(m, id)
  consent = null                                  // user answered it in Claude
  const r = await m.answerClaudeDesktop(id, 'Deny 1')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'prompt-gone')
  assert.deepEqual(act.answered, [], 'must not type at a prompt that is gone')
  m.killAll(); m.stopMaintenance()
})

test('answering a non-Claude-desktop task is refused', async () => {
  const base = await tmp()
  const m = await managerFull(fakeDriver({ tasks: [{}] }), fakeAx(), fakeActuator(), base)
  const r = await m.answerClaudeDesktop('nope', 'Deny 1')
  assert.equal(r.ok, false)
  m.killAll(); m.stopMaintenance()
})

test('with no actuator the prompt is visible but honestly unanswerable', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'Fix login', lastFocusedAt: Date.now() }], snapshots: [{ updatedAt: 5000 }] })
  const m = await managerWithAx(d, fakeAx({ consent: { question: 'Allow?' } }), base)
  const [id] = await m.adoptClaudeDesktop()
  await pollForced(m, id)
  const r = await m.answerClaudeDesktop(id, 'Deny 1')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-actuator')
  m.killAll(); m.stopMaintenance()
})

// ── sending into an existing conversation ─────────────────────────────────

function fakeActuatorFull(res: { ok: boolean; reason?: string } = { ok: true }) {
  const sent: Array<{ title: string; text: string }> = []
  return {
    sent,
    answerConsent: async () => ({ ok: true }),
    sendTo: async (title: string, text: string) => { sent.push({ title, text }); return res },
    send: async () => res,
    openConversation: async () => ({ ok: true }),
  }
}

test('sending addresses the conversation by title, in one intent', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'Fix login' }], snapshots: [{ updatedAt: 5000, lastAgentMessage: 'ok' }] })
  const act = fakeActuatorFull()
  const m = await managerFull(d, fakeAx(), act, base)
  const [id] = await m.adoptClaudeDesktop()
  const r = await m.sendClaudeDesktop(id, 'try the other branch')
  assert.equal(r.ok, true)
  assert.deepEqual(act.sent, [{ title: 'Fix login', text: 'try the other branch' }])
  assert.equal(m.get(id)!.state, 'processing')
  m.killAll(); m.stopMaintenance()
})

test('a delivery failure is NOT a task failure', async () => {
  // The conversation is fine; our message did not arrive. Same distinction the
  // PTY backends draw with deliveryError.
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'Fix login' }], snapshots: [{ updatedAt: 5000 }] })
  const m = await managerFull(d, fakeAx(), fakeActuatorFull({ ok: false, reason: 'row-not-found' }), base)
  const [id] = await m.adoptClaudeDesktop()
  const r = await m.sendClaudeDesktop(id, 'hello')
  assert.equal(r.ok, false)
  assert.equal(m.get(id)!.deliveryError, 'row-not-found')
  assert.notEqual(m.get(id)!.state, 'failed')
  m.killAll(); m.stopMaintenance()
})

test('sending is refused while the task is blocked on a prompt', async () => {
  // Typing prose at a permission prompt puts it somewhere unpredictable and
  // leaves the prompt unanswered.
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'Fix login', lastFocusedAt: Date.now() }], snapshots: [{ updatedAt: 5000 }] })
  const act = fakeActuatorFull()
  const m = await managerFull(d, fakeAx({ consent: { question: 'Allow Claude to write?' } }), act, base)
  const [id] = await m.adoptClaudeDesktop()
  await pollForced(m, id)
  assert.equal(m.get(id)!.state, 'needs-user')
  const r = await m.sendClaudeDesktop(id, 'hello')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'answer-the-prompt-first')
  assert.deepEqual(act.sent, [])
  m.killAll(); m.stopMaintenance()
})

test('a task with no title cannot be addressed, and says so', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: null }], snapshots: [{ updatedAt: 5000 }] })
  const m = await managerFull(d, fakeAx(), fakeActuatorFull(), base)
  const [id] = await m.adoptClaudeDesktop()
  const r = await m.sendClaudeDesktop(id, 'hello')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-title-to-address')
  m.killAll(); m.stopMaintenance()
})

// ── creating a new conversation ───────────────────────────────────────────

test('the new task is found by DIFFING the store, never by taking "the newest"', async () => {
  // Taking the newest without a before-set is how the Codex backend once bound
  // two cards to one thread.
  const base = await tmp()
  const existing = { title: 'Old chat' }
  const d = fakeDriver({ tasks: [existing], snapshots: [{ updatedAt: 1 }] })
  const act = {
    ...fakeActuatorFull(),
    createTask: async () => {
      // The app writes the new conversation to the store.
      ;(d as unknown as { push(t: Record<string, unknown>): void }).push({ title: 'Brand new' })
      return { ok: true as const }
    },
  }
  const m = await managerFull(d, fakeAx(), act, base)
  const r = await m.createClaudeDesktop('do the thing')
  assert.equal(r.ok, true)
  const created = m.list().find((t) => t.name === 'Brand new')
  assert.ok(created, 'the NEW conversation must be the one adopted')
  m.killAll(); m.stopMaintenance()
})

test('a creation whose id never appears still reports ok — the work DID start', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [] })
  const act = { ...fakeActuatorFull(), createTask: async () => ({ ok: true as const }) }
  const m = await managerFull(d, fakeAx(), act, base)
  const r = await m.createClaudeDesktop('do the thing', { tries: 1, waitMs: 1 })
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'id-unresolved')
  m.killAll(); m.stopMaintenance()
})

test('a failed creation is reported as failed, not silently ok', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [] })
  const act = { ...fakeActuatorFull(), createTask: async () => ({ ok: false as const, reason: 'tree-dead' as const }) }
  const m = await managerFull(d, fakeAx(), act, base)
  const r = await m.createClaudeDesktop('do the thing')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'tree-dead')
  m.killAll(); m.stopMaintenance()
})

test('an empty intent never touches the app', async () => {
  const base = await tmp()
  let called = false
  const act = { ...fakeActuatorFull(), createTask: async () => { called = true; return { ok: true as const } } }
  const m = await managerFull(fakeDriver({ tasks: [] }), fakeAx(), act, base)
  const r = await m.createClaudeDesktop('   ')
  assert.equal(r.ok, false)
  assert.equal(called, false)
  m.killAll(); m.stopMaintenance()
})

test('the default window is a week — a day adopted NOTHING on a real machine', async () => {
  // Measured: 33 real conversations, 0 with activity inside 24h, newest 32.8h.
  // A 24h default rendered an empty wall on a machine full of chats.
  const base = await tmp()
  const now = Date.now()
  const m = await makeManager(
    fakeDriver({ tasks: [{ lastActivityAt: now - 33 * 3600_000 }] }), base, () => now)
  assert.equal((await m.adoptClaudeDesktop()).length, 1)
  m.killAll(); m.stopMaintenance()
})

// ── dismissal ─────────────────────────────────────────────────────────────

test('a removed card does NOT come back on the next sweep', async () => {
  // Observed live: removed 21:28:49, re-adopted 21:29:07, removed 21:29:43,
  // back 21:30:07. A card the user cannot get rid of is worse than one that
  // never appeared.
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'Fix login' }] })
  const m = await makeManager(d, base)
  const [id] = await m.adoptClaudeDesktop()
  await m.remove(id)
  assert.deepEqual(await m.adoptClaudeDesktop(), [], 'the sweep must not overrule the user')
  m.killAll(); m.stopMaintenance()
})

test('the dismissal SURVIVES a restart — the conversation still exists in the app', async () => {
  const base = await tmp()
  const mk = async () => makeManager(fakeDriver({ tasks: [{ title: 'Fix login' }] }), base)
  const m1 = await mk()
  const [id] = await m1.adoptClaudeDesktop()
  await m1.remove(id)
  m1.killAll(); m1.stopMaintenance()

  const m2 = await mk()                       // fresh manager, same baseDir
  assert.deepEqual(await m2.adoptClaudeDesktop(), [], 'an in-memory set would resurrect it')
  m2.killAll(); m2.stopMaintenance()
})

test('dismissing one conversation does not hide the others', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'One' }, { title: 'Two' }] })
  const m = await makeManager(d, base)
  const ids = await m.adoptClaudeDesktop()
  const one = ids.map((i) => m.get(i)!).find((t) => t.name === 'One')!
  await m.remove(one.id)
  const again = await m.adoptClaudeDesktop()
  assert.deepEqual(again, [], 'Two is still adopted, so nothing new to take')
  assert.equal(m.list().filter((t) => t.agent === 'claude-code-desktop').length, 1)
  assert.equal(m.list().find((t) => t.agent === 'claude-code-desktop')!.name, 'Two')
  m.killAll(); m.stopMaintenance()
})

// ── surviving a restart ───────────────────────────────────────────────────

test('a rehydrated card keeps its session id — without it, duplicates every launch', async () => {
  // Measured after four installs: 18 cards for 6 conversations, exactly 3
  // duplicates each. Rehydrate rebuilt the cards WITHOUT claudeDesktopSessionId,
  // so adoption's dedupe saw nothing and re-adopted the whole store each time.
  const base = await tmp()
  const mk = async () => makeManager(fakeDriver({ tasks: [{ title: 'Fix login' }] }), base)

  const m1 = await mk()
  assert.equal((await m1.adoptClaudeDesktop()).length, 1)
  m1.killAll(); m1.stopMaintenance()

  const m2 = await mk()          // fresh manager, same baseDir = an app restart
  await m2.rehydrate()
  const restored = m2.list().filter((t) => t.agent === 'claude-code-desktop')
  assert.equal(restored.length, 1, 'the card must come back')
  assert.ok(restored[0].claudeDesktopSessionId, 'and must keep its session id')

  assert.deepEqual(await m2.adoptClaudeDesktop(), [], 'so the sweep adds no duplicate')
  assert.equal(m2.list().filter((t) => t.agent === 'claude-code-desktop').length, 1)
  m2.killAll(); m2.stopMaintenance()
})

test('a rehydrated card can still poll', async () => {
  // Without the session id pollClaudeDesktop bails immediately, leaving a card
  // that never updates again.
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'Fix login' }], snapshots: [{ updatedAt: 5000, lastAgentMessage: 'hi' }] })
  const m1 = await makeManager(d, base)
  await m1.adoptClaudeDesktop()
  m1.killAll(); m1.stopMaintenance()

  const m2 = await makeManager(d, base)
  await m2.rehydrate()
  const id = m2.list().find((t) => t.agent === 'claude-code-desktop')!.id
  await pollForced(m2, id)
  assert.equal(m2.get(id)!.threadContext, 'hi', 'the poll must have run')
  m2.killAll(); m2.stopMaintenance()
})

// ── the composer: reply vs answer ─────────────────────────────────────────

async function blockedManager(base: string) {
  const d = fakeDriver({ tasks: [{ title: 'Fix login', lastFocusedAt: Date.now() }], snapshots: [{ updatedAt: 5000 }] })
  const act = fakeActuatorFull()
  const answered: string[] = []
  ;(act as unknown as { answerConsent: unknown }).answerConsent =
    async (_c: unknown, label: string) => { answered.push(label); return { ok: true } }
  const m = await managerFull(d, fakeAx({ consent: { question: 'Allow Claude to write a file?' } }), act, base)
  const [id] = await m.adoptClaudeDesktop()
  await pollForced(m, id)
  return { m, id, act, answered }
}

test('typing an option label while blocked ANSWERS the prompt', async () => {
  // Sending it as a message would leave the dialog waiting AND add a stray
  // line to the user's conversation.
  const { m, id, act, answered } = await blockedManager(await tmp())
  assert.equal(m.get(id)!.state, 'needs-user')
  m.answer(id, 'deny')                       // no digit, lowercase — as a human types
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(answered, ['Deny 1'], 'matched to the real option label')
  assert.deepEqual(act.sent, [], 'and NOT sent as a message')
  m.killAll(); m.stopMaintenance()
})

test('typing something else while blocked is a REPLY, not a forced Deny', async () => {
  // "no, do it differently" must never be silently mapped onto an option.
  const { m, id, answered } = await blockedManager(await tmp())
  m.answer(id, 'no, do it differently')
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(answered, [], 'must not press anything')
  m.killAll(); m.stopMaintenance()
})

test('a reply on an unblocked task is sent as a message', async () => {
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'Fix login' }], snapshots: [{ updatedAt: 5000 }] })
  const act = fakeActuatorFull()
  const m = await managerFull(d, fakeAx(), act, base)
  const [id] = await m.adoptClaudeDesktop()
  m.answer(id, 'try the other branch')
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(act.sent, [{ title: 'Fix login', text: 'try the other branch' }])
  m.killAll(); m.stopMaintenance()
})

test('a Claude desktop reply never reaches the Codex path', async () => {
  // isExternalAgent is true for BOTH driver backends, so without explicit
  // routing the reply fell into followUpCodexDesktop and was dropped silently.
  const base = await tmp()
  const d = fakeDriver({ tasks: [{ title: 'Fix login' }], snapshots: [{ updatedAt: 5000 }] })
  const act = fakeActuatorFull()
  const m = new TaskManager({
    executorFactory: () => { throw new Error('no executor') },
    claudeDesktopDriver: d as never,
    claudeDesktopAx: fakeAx() as never,
    claudeActuator: act as never,
    codexDriver: { snapshot: async () => { throw new Error('CODEX PATH — must not be reached') } } as never,
    baseDir: base, userKey: 'test', pollMs: 10_000,
  })
  const [id] = await m.adoptClaudeDesktop()
  m.answer(id, 'hello')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(act.sent.length, 1, 'went to the Claude actuator')
  m.killAll(); m.stopMaintenance()
})

// ── dispatch ──────────────────────────────────────────────────────────────

test('dispatching to claude-code-desktop NEVER touches the Codex path', async () => {
  // isExternalAgent is true for both driver backends, so without explicit
  // routing this went to dispatchCodexDesktop and tried to talk to Codex over
  // CDP about a conversation that does not exist there.
  const base = await tmp()
  const d = fakeDriver({ tasks: [] })
  const act = { ...fakeActuatorFull(), createTask: async () => {
    ;(d as unknown as { push(t: Record<string, unknown>): void }).push({ title: 'From Unmute' })
    return { ok: true as const }
  } }
  const m = new TaskManager({
    executorFactory: () => { throw new Error('no PTY for a driven backend') },
    claudeDesktopDriver: d as never,
    claudeDesktopAx: fakeAx() as never,
    claudeActuator: act as never,
    codexDriver: { createTask: async () => { throw new Error('CODEX PATH — must not be reached') } } as never,
    baseDir: base, userKey: 'test', pollMs: 10_000,
  })
  const id = await m.dispatch('do the thing', { agent: 'claude-code-desktop' })
  assert.equal(m.get(id)!.agent, 'claude-code-desktop')
  assert.equal(m.get(id)!.name, 'From Unmute')
  m.killAll(); m.stopMaintenance()
})

test('a failed creation throws a typed reason rather than a silent success', async () => {
  const base = await tmp()
  const act = { ...fakeActuatorFull(), createTask: async () => ({ ok: false as const, reason: 'tree-dead' as const }) }
  const m = await managerFull(fakeDriver({ tasks: [] }), fakeAx(), act, base)
  await assert.rejects(() => m.dispatch('x', { agent: 'claude-code-desktop' }), /CLAUDE_DESKTOP_UNAVAILABLE: tree-dead/)
  m.killAll(); m.stopMaintenance()
})
