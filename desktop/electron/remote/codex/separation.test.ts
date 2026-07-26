import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskManager } from '../task-manager'
import { isExternalAgent } from '../codex-executor'
import { threadIdFromRolloutName } from './rollout'

// THE SEPARATION INVARIANT
//
// A task the user routed to Codex must NEVER become a task on another agent —
// not on failure, not on retry, not through any failsafe. On 2026-07-25 it did:
// a thread-id lookup timed out, the dispatch threw, a generic router failsafe
// caught it and re-dispatched WITHOUT the backend, and the user's work ran a
// second time on Claude Code — an agent they had explicitly not chosen, and
// which many users will not even have installed.
//
// These tests pin the invariant at the two places it can break: the executor
// factory (which used to fall through to Claude for any unrecognised agent) and
// the dispatch path (which must fail as a Codex task rather than reroute).

const tmp = () => fs.mkdtemp(join(tmpdir(), 'unmute-sep-'))

test('a Codex dispatch NEVER constructs a PTY executor', async () => {
  const base = await tmp()
  let executorBuilt = 0
  const m = new TaskManager({
    // If this ever runs for a codex-desktop task the separation is broken.
    executorFactory: () => { executorBuilt++; throw new Error('PTY executor built for a Codex task') },
    codexDriver: {
      createTask: async () => ({ ok: true as const, threadId: 'thread-abc' }),
      send: async () => ({ ok: true as const }),
      openThread: async () => true,
      snapshot: async () => ({ state: 'processing', lastAgentMessage: null, turns: [], updatedAt: Date.now(), turnsStarted: 1, everCompleted: false }),
    } as never,
    baseDir: base, userKey: 'test', pollMs: 10_000, trustAcceptMs: 0,
  })
  const id = await m.dispatch('do it in codex', { agent: 'codex-desktop' })
  assert.equal(m.get(id)?.agent, 'codex-desktop')
  assert.equal(executorBuilt, 0, 'no PTY executor may be built for a Codex task')
  m.killAll(); m.stopMaintenance()
})

test('a Codex FAILURE stays a Codex failure — it never becomes another task', async () => {
  // The exact 2026-07-25 shape: the send worked, only the id lookup failed.
  const base = await tmp()
  let executorBuilt = 0
  const m = new TaskManager({
    executorFactory: () => { executorBuilt++; throw new Error('PTY executor built after a Codex failure') },
    codexDriver: {
      createTask: async () => ({ ok: false as const, reason: 'id-unresolved' as const }),
      send: async () => ({ ok: true as const }),
      openThread: async () => true,
      snapshot: async () => ({ state: 'processing', lastAgentMessage: null, turns: [], updatedAt: Date.now(), turnsStarted: 0, everCompleted: false }),
    } as never,
    baseDir: base, userKey: 'test', pollMs: 10_000, trustAcceptMs: 0,
  })
  await assert.rejects(
    () => m.dispatch('do it in codex', { agent: 'codex-desktop' }),
    /CODEX_UNAVAILABLE: id-unresolved/,
    'the failure must name the backend so callers cannot mistake it for a routing error',
  )
  // And crucially: nothing was started anywhere else.
  assert.equal(executorBuilt, 0)
  assert.equal(m.list().length, 0, 'a failed Codex dispatch must not leave a task on another agent')
  m.killAll(); m.stopMaintenance()
})

test('isExternalAgent marks exactly the backends with no PTY', () => {
  // The executor factory keys off this to throw rather than fall through to
  // Claude, so a wrong answer here silently reintroduces the crossing.
  assert.equal(isExternalAgent('codex-desktop'), true)
  assert.equal(isExternalAgent('claude'), false)
  assert.equal(isExternalAgent('codex'), false)   // the CLI adapter DOES own a PTY
  assert.equal(isExternalAgent(undefined), false)
})

test('the durable thread id is read from the rollout FILENAME', () => {
  // The DOM only ever exposes a transient `client-new-thread:` id, so the
  // filename is the authority. Getting this wrong is what started the incident.
  assert.equal(
    threadIdFromRolloutName('rollout-2026-07-25T02-40-24-019f95f7-1127-7792-9a96-e1148ed6d954.jsonl'),
    '019f95f7-1127-7792-9a96-e1148ed6d954',
  )
  assert.equal(threadIdFromRolloutName('notes.txt'), null)
  assert.equal(threadIdFromRolloutName('rollout-broken.jsonl'), null)
})
