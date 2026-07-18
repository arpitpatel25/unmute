// DriverManager pool semantics: distinct child per session (parallelism
// BETWEEN Claude Code sessions; stdio serializes WITHIN one — cua's model),
// stable child per session id, reaping, restart, dispose.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DriverManager } from './driver-manager'

const FAKE = join(process.cwd(), 'electron', 'remote', 'cua', 'fake-driver.mjs')

function mgr(extra: Partial<ConstructorParameters<typeof DriverManager>[0]> = {}): DriverManager {
  return new DriverManager({ binPath: process.execPath, binArgs: [FAKE], permissionPollMs: 0, ...extra })
}

async function pidOf(c: { request(m: string, p?: unknown): Promise<unknown> }): Promise<string> {
  const res = (await c.request('tools/call', { name: '__pid', arguments: {} })) as any
  return res.content[0].text as string
}

test('per-session children: distinct sessions get distinct processes; same session is stable', async () => {
  const m = mgr()
  try {
    const a1 = await pidOf(m.forSession('sess-a'))
    const a2 = await pidOf(m.forSession('sess-a'))
    const b = await pidOf(m.forSession('sess-b'))
    const d = await pidOf(m.forSession(undefined))
    assert.equal(a1, a2)
    assert.notEqual(a1, b)
    assert.notEqual(a1, d)
  } finally { m.dispose() }
})

test('endSession kills that child only', async () => {
  const m = mgr()
  try {
    const a = m.forSession('sess-a')
    const b = m.forSession('sess-b')
    m.endSession('sess-a')
    assert.equal(a.alive, false)
    assert.equal(b.alive, true)
  } finally { m.dispose() }
})

test('restartAll: children die; next access spawns fresh processes', async () => {
  const m = mgr()
  try {
    const before = await pidOf(m.forSession('sess-a'))
    m.restartAll()
    const after = await pidOf(m.forSession('sess-a'))
    assert.notEqual(before, after)
  } finally { m.dispose() }
})

test('dispose kills everything', async () => {
  const m = mgr()
  const a = m.forSession('sess-a')
  const d = m.default()
  m.dispose()
  assert.equal(a.alive, false)
  assert.equal(d.alive, false)
})

test('after dispose: default()/forSession() throw and spawn nothing (no leak)', () => {
  const m = mgr()
  m.dispose()
  const before = (m as any).spawnCount as number
  assert.throws(() => m.default(), /disposed/)
  assert.throws(() => m.forSession('x'), /disposed/)
  assert.throws(() => m.forSession(undefined), /disposed/)
  assert.equal((m as any).spawnCount, before) // a throw that still spawned would leak
})

test('permission poll gated on getEnabled: disabled users never get a child', async () => {
  // Tiny poll cadence + a binPath that would be observable if ever spawned.
  const m = new DriverManager({
    binPath: '/nonexistent/definitely-not-a-binary',
    permissionPollMs: 50,
    getEnabled: () => false,
  })
  try {
    await new Promise((r) => setTimeout(r, 200)) // several poll ticks
    assert.equal((m as any).spawnCount, 0)
  } finally { m.dispose() }
})
