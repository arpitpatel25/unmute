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
    send: async (threadId: string, text: string) => {
      calls.push({ fn: 'send', args: [threadId, text] })
      return { ok: true as const }
    },
    openThread: async () => true,
    snapshot: async () => {
      const s = script.states?.[Math.min(i++, (script.states?.length ?? 1) - 1)]
        ?? { state: 'processing' }
      return { turns: [], updatedAt: Date.now(), turnsStarted: 1, everCompleted: false, lastAgentMessage: null, ...s } as never
    },
  }
}

async function makeManager(driver: unknown, baseDir: string) {
  return new TaskManager({
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
  // created project-scoped, with the user's words verbatim
  assert.deepEqual(d.calls[0], { fn: 'createTask', args: ['fix the login bug', { project: 'unmute' }] })
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
