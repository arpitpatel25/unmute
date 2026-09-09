import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeRuntimeService } from './claude-service'
import type { ClaudeTaskSession, ClaudeTaskOptions } from '../claude/task-session'

// THE FAILURE THESE GUARD, stated once so the numbers below mean something.
//
// Measured 2026-09-09: six `claude -p` processes alive for twenty hours under a
// runtime whose app had quit long before, one of them started five hours after
// that app was gone. Nothing swept them — the app-side sweep covers `executors`
// and these live in the daemon, where no app-side timer can reach.
//
// The rule the tests below encode: a session mid-turn is untouchable at any
// age; an idle one is kept warm for a calendar floor and then let go; and the
// number alive at once is bounded, because it is the concurrent count that
// costs the memory.

interface Fake { alive: boolean; busy: boolean; closed: number }

function harness(limits: { idleMs?: number; maxSessions?: number } = {}) {
  const drivers = new Map<string, Fake>()
  const opened: ClaudeTaskOptions[] = []
  let clock = 1_000_000
  const make = (root: string) => new ClaudeRuntimeService(root, () => {}, (input: ClaudeTaskOptions) => {
    opened.push(input)
    const driver: Fake = {
      alive: false, busy: false, closed: 0,
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      async start(this: Fake) { this.alive = true },
      close(this: Fake) { this.alive = false; this.closed += 1 },
      models: [], followupBlocked: false, followupUnavailable: false,
    } as unknown as Fake
    drivers.set(String(input.sessionId), driver)
    return driver as unknown as ClaudeTaskSession
  }, { ...limits, sweepMs: 60_000, now: () => clock })
  return { make, drivers, opened, tick: (ms: number) => { clock += ms }, at: () => clock }
}

const open = (service: ClaudeRuntimeService, id: string, root: string) =>
  service.invoke('open', [id, { sessionId: id, binary: 'claude', cwd: root, resume: true }])

test('an idle session is kept warm for the floor, then released', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lifetime-idle-'))
  const h = harness({ idleMs: 60_000 })
  const service = h.make(root)
  try {
    await open(service, 'a', root)
    assert.equal(service.sessionCount, 1)

    // Inside the floor: kept, however many sweeps run.
    h.tick(59_000)
    service.sweepIdle()
    assert.equal(service.sessionCount, 1, 'released before its warm window expired')
    assert.equal(h.drivers.get('a')!.closed, 0)

    // Past it: let go.
    h.tick(2_000)
    service.sweepIdle()
    assert.equal(service.sessionCount, 0)
    assert.equal(h.drivers.get('a')!.closed, 1)
  } finally { service.close(); await rm(root, { recursive: true, force: true }) }
})

// THE ONE THAT MUST NEVER BREAK. A turn in flight is exactly the work the
// detached runtime exists to protect: resuming cannot recover an answer that
// was never finished.
test('a session mid-turn is never released, at any age', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lifetime-busy-'))
  const h = harness({ idleMs: 60_000 })
  const service = h.make(root)
  try {
    await open(service, 'a', root)
    h.drivers.get('a')!.busy = true
    h.tick(30 * 24 * 60 * 60_000)   // a month
    service.sweepIdle()
    assert.equal(service.sessionCount, 1)
    assert.equal(h.drivers.get('a')!.closed, 0)

    // …and it is collected once the turn actually ends.
    h.drivers.get('a')!.busy = false
    service.sweepIdle()
    assert.equal(service.sessionCount, 0)
  } finally { service.close(); await rm(root, { recursive: true, force: true }) }
})

test('being spoken to resets the clock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lifetime-touch-'))
  const h = harness({ idleMs: 60_000 })
  const service = h.make(root)
  try {
    await open(service, 'a', root)
    h.tick(50_000)
    await service.invoke('state', ['a'])   // an attached UI watching it
    h.tick(50_000)                          // 100s total, but only 50s since use
    service.sweepIdle()
    assert.equal(service.sessionCount, 1, 'idleness measured from open rather than last use')
  } finally { service.close(); await rm(root, { recursive: true, force: true }) }
})

test('a released session reopens on the same identity, resuming', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lifetime-reopen-'))
  const h = harness({ idleMs: 60_000 })
  const service = h.make(root)
  try {
    await open(service, 'a', root)
    h.tick(120_000)
    service.sweepIdle()
    assert.equal(service.sessionCount, 0)

    const state = await open(service, 'a', root) as { alive: boolean }
    assert.equal(state.alive, true)
    assert.equal(service.sessionCount, 1)
    // The conversation is a transcript on disk; the process is a cache.
    assert.equal(h.opened.length, 2)
    assert.equal(h.opened[1].sessionId, 'a')
    assert.equal(h.opened[1].resume, true)
  } finally { service.close(); await rm(root, { recursive: true, force: true }) }
})

test('the cap bounds how many run at once, evicting the least recently used idle one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lifetime-cap-'))
  const h = harness({ maxSessions: 2, idleMs: 60 * 60_000 })
  const service = h.make(root)
  try {
    await open(service, 'a', root); h.tick(1_000)
    await open(service, 'b', root); h.tick(1_000)
    assert.equal(service.sessionCount, 2)

    await service.invoke('state', ['a'])   // 'a' is now the more recently used
    h.tick(1_000)
    await open(service, 'c', root)

    assert.equal(service.sessionCount, 2, 'the cap did not hold')
    assert.equal(h.drivers.get('b')!.closed, 1, 'evicted the wrong session')
    assert.equal(h.drivers.get('a')!.closed, 0)
  } finally { service.close(); await rm(root, { recursive: true, force: true }) }
})

// A cap that can refuse work is worse than the problem it prevents.
test('the cap never blocks work when every session is mid-turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lifetime-cap-busy-'))
  const h = harness({ maxSessions: 2, idleMs: 60 * 60_000 })
  const service = h.make(root)
  try {
    await open(service, 'a', root)
    await open(service, 'b', root)
    h.drivers.get('a')!.busy = true
    h.drivers.get('b')!.busy = true

    const state = await open(service, 'c', root) as { alive: boolean }
    assert.equal(state.alive, true, 'a new session was refused while others were busy')
    assert.equal(service.sessionCount, 3, 'overshoot is allowed; the sweep collects it')
    assert.equal(h.drivers.get('a')!.closed, 0)
    assert.equal(h.drivers.get('b')!.closed, 0)
  } finally { service.close(); await rm(root, { recursive: true, force: true }) }
})

test('reopening a session already held does not consume a slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lifetime-reopen-cap-'))
  const h = harness({ maxSessions: 2, idleMs: 60 * 60_000 })
  const service = h.make(root)
  try {
    await open(service, 'a', root)
    await open(service, 'b', root)
    await open(service, 'a', root)   // same one again
    assert.equal(service.sessionCount, 2)
    assert.equal(h.drivers.get('b')!.closed, 0, 'reopening an existing session evicted a neighbour')
  } finally { service.close(); await rm(root, { recursive: true, force: true }) }
})

test('busy reports whether anything is mid-turn, so the daemon can decide to stand down', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lifetime-busy-flag-'))
  const h = harness({ idleMs: 60_000 })
  const service = h.make(root)
  try {
    assert.equal(service.busy, false)
    await open(service, 'a', root)
    assert.equal(service.busy, false)
    h.drivers.get('a')!.busy = true
    assert.equal(service.busy, true)
  } finally { service.close(); await rm(root, { recursive: true, force: true }) }
})

test('close stops the sweep and lets go of everything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lifetime-close-'))
  const h = harness({ idleMs: 60_000 })
  const service = h.make(root)
  await open(service, 'a', root)
  service.close()
  assert.equal(service.sessionCount, 0)
  assert.equal(h.drivers.get('a')!.closed, 1)
  await rm(root, { recursive: true, force: true })
})
