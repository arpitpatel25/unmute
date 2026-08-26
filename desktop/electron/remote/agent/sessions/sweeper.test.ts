import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IDLE_MS, SessionSweeper, isIdle, summariesEnabled } from './sweeper'
import { SessionStore } from './store'
import type { SessionRoots } from './scan'

const answer = JSON.stringify({
  about: 'Editing the promo video', done: ['cut the intro'], standing: 'mid-edit', touched: [],
})

async function fixture(touchedAgo = 10 * 60_000) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'agent-sweep-'))
  const roots: SessionRoots = {
    claudeProjects: join(dir, 'claude', 'projects'),
    codexSessions: join(dir, 'codex', 'sessions'),
    agentRuntime: join(dir, 'appsupport', 'unmute-agent'),
  }
  await fs.mkdir(join(roots.claudeProjects, '-Users-me-repo'), { recursive: true })
  await fs.mkdir(join(roots.codexSessions), { recursive: true })
  const file = join(roots.claudeProjects, '-Users-me-repo', 'a.jsonl')
  await fs.writeFile(file, [
    JSON.stringify({ type: 'user', cwd: '/Users/me/repo', sessionId: 's1', message: { content: 'cut the intro' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Trimmed it.' }] } }),
  ].join('\n'))
  const when = new Date(Date.now() - touchedAgo)
  await fs.utimes(file, when, when)
  const store = new SessionStore({ cachePath: join(dir, 'sessions', 'record.json'), roots })
  return { dir, roots, file, store, recordPath: join(dir, 'sessions', 'recent-sessions.md') }
}

/** The off switch has to work without a rebuild — a background spender whose
 *  failure modes are hard to debug is worth being able to stop. */
test('the environment switch turns every model call off', async () => {
  assert.equal(summariesEnabled({}), true)
  assert.equal(summariesEnabled({ UNMUTE_AGENT_SESSION_SUMMARIES: '1' }), true)
  assert.equal(summariesEnabled({ UNMUTE_AGENT_SESSION_SUMMARIES: '0' }), false)

  const { dir, store, recordPath } = await fixture()
  try {
    let calls = 0
    const sweeper = new SessionSweeper({
      store, recordPath, parseJson: JSON.parse,
      env: { UNMUTE_AGENT_SESSION_SUMMARIES: '0' },
      run: async () => { calls += 1; return { ok: true as const, output: answer } },
    })
    await sweeper.tick()
    assert.equal(calls, 0)
    await assert.rejects(fs.readFile(recordPath), 'no record is written when it is off')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a quiet session is summarised and the record is written', async () => {
  const { dir, store, recordPath } = await fixture()
  try {
    const sweeper = new SessionSweeper({
      store, recordPath, parseJson: JSON.parse,
      run: async () => ({ ok: true as const, output: answer }),
    })
    await sweeper.tick()
    const body = await fs.readFile(recordPath, 'utf8')
    assert.match(body, /Editing the promo video/)
    assert.match(body, /- cut the intro/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

/** A session still being typed into has no coherent state to record. */
test('a session touched seconds ago is left for the next pass', async () => {
  const { dir, store, recordPath } = await fixture(5_000)
  try {
    let calls = 0
    const sweeper = new SessionSweeper({
      store, recordPath, parseJson: JSON.parse,
      run: async () => { calls += 1; return { ok: true as const, output: answer } },
    })
    await sweeper.tick()
    assert.equal(calls, 0, 'nothing mid-turn was summarised')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('idleness is measured against the last touch', () => {
  const now = 1_000_000
  assert.equal(isIdle(now - IDLE_MS - 1, now), true)
  assert.equal(isIdle(now - 1_000, now), false)
  assert.equal(isIdle(now - 500, now, 100), true)
})

/** Two passes summarising the same session would both advance one cursor. */
test('a sweep never overlaps itself', async () => {
  const { dir, store, recordPath } = await fixture()
  try {
    let inFlight = 0
    let overlapped = false
    const sweeper = new SessionSweeper({
      store, recordPath, parseJson: JSON.parse,
      run: async () => {
        inFlight += 1
        if (inFlight > 1) overlapped = true
        await new Promise((r) => setTimeout(r, 10))
        inFlight -= 1
        return { ok: true as const, output: answer }
      },
    })
    await Promise.all([sweeper.tick(), sweeper.tick(), sweeper.tick()])
    assert.equal(overlapped, false)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

/** Housekeeping must never take the Agent down with it. */
test('a thrown sweep is swallowed, not propagated', async () => {
  const { dir, recordPath } = await fixture()
  try {
    const exploding = {
      refresh: async () => { throw new Error('disk on fire') },
      all: () => [],
      load: async () => {},
    } as unknown as SessionStore
    const sweeper = new SessionSweeper({
      store: exploding, recordPath, parseJson: JSON.parse,
      run: async () => ({ ok: true as const, output: answer }),
    })
    await sweeper.tick()
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('stopping aborts in-flight work and stops the timer', async () => {
  const { dir, store, recordPath } = await fixture()
  try {
    const sweeper = new SessionSweeper({
      store, recordPath, parseJson: JSON.parse,
      run: async () => ({ ok: true as const, output: answer }),
    })
    sweeper.stop()
    let calls = 0
    const counting = new SessionSweeper({
      store, recordPath, parseJson: JSON.parse,
      run: async () => { calls += 1; return { ok: true as const, output: answer } },
    })
    counting.stop()
    await counting.tick()
    assert.equal(calls, 0)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
