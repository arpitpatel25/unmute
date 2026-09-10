import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CodexAppServer } from './app-server-client.ts'

class FakeSocket extends EventTarget {
  readyState = 0
  constructor() {
    super()
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) })
  }
  send(raw: string): void {
    const frame = JSON.parse(raw)
    if (typeof frame.id === 'number') queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }),
    })))
  }
  close(): void { this.readyState = 3; this.dispatchEvent(new Event('close')) }
}

test('a restarted runtime adopts its verified app-server owner without spawning a second writer', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-owner-adopt-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ownerFile = join(dir, 'owner.json')
  await writeFile(ownerFile, JSON.stringify({ pid: 4242, port: 54321, generation: 'old-runtime' }))
  let spawned = 0
  const killed: number[] = []
  const server = new CodexAppServer({
    bin: '/codex', ownerFile,
    spawnImpl: (() => { spawned++; throw new Error('must not spawn') }) as never,
    inspectProcess: async () => 'UNMUTE_APP_SERVER=1 /codex app-server --listen ws://127.0.0.1:54321',
    killImpl: pid => { killed.push(pid) },
    fetchImpl: async () => ({ ok: true }) as Response,
    wsFactory: () => new FakeSocket() as never,
  })
  await server.start()
  assert.equal(server.url, 'ws://127.0.0.1:54321')
  assert.equal(spawned, 0)
  server.stop()
  assert.deepEqual(killed, [4242])
})

test('a verified live but unreachable owner fails closed instead of spawning a competing writer', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-owner-fence-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ownerFile = join(dir, 'owner.json')
  await writeFile(ownerFile, JSON.stringify({ pid: 5252, port: 54322, generation: 'live-owner' }))
  let spawned = 0
  const server = new CodexAppServer({
    bin: '/codex', ownerFile,
    spawnImpl: (() => { spawned++; throw new Error('must not spawn') }) as never,
    inspectProcess: async () => 'UNMUTE_APP_SERVER=1 /codex app-server --listen ws://127.0.0.1:54322',
    fetchImpl: async () => { throw new Error('connection refused') },
    readyTimeoutMs: 5, readyPollMs: 1,
  })
  await assert.rejects(server.start(), /existing app-server owner is alive but unreachable/)
  assert.equal(spawned, 0)
})

test('a proven dead owner is cleared and replaced exactly once', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-owner-stale-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ownerFile = join(dir, 'owner.json')
  await writeFile(ownerFile, JSON.stringify({ pid: 6161, port: 54323, generation: 'dead-owner' }))
  let spawned = 0, killed = 0
  const child = Object.assign(new EventEmitter(), {
    pid: 6262, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { killed++; return true },
  })
  const server = new CodexAppServer({
    bin: '/codex', ownerFile, port: 54324,
    spawnImpl: (() => { spawned++; return child }) as never,
    inspectProcess: async () => null,
    fetchImpl: async () => ({ ok: true }) as Response,
    wsFactory: () => new FakeSocket() as never,
  })
  await server.start()
  assert.equal(spawned, 1)
  assert.equal(JSON.parse(await readFile(ownerFile, 'utf8')).pid, 6262)
  server.stop()
  assert.equal(killed, 1)
})

test('a live owner election prevents concurrent app-server spawn', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-owner-election-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ownerFile = join(dir, 'owner.json')
  await symlink(`${process.pid}:other-runtime`, `${ownerFile}.claim`)
  let spawned = 0
  const server = new CodexAppServer({
    bin: '/codex', ownerFile, port: 54325,
    spawnImpl: (() => { spawned++; throw new Error('must not spawn') }) as never,
    inspectProcess: async () => 'node persistent-runtime',
  })
  await assert.rejects(server.start(), /owner election is already in progress/)
  assert.equal(spawned, 0)
})
