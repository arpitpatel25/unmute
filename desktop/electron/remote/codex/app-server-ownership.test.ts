import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CodexAppServer } from './app-server-client.ts'

class FakeSocket extends EventTarget {
  readyState = 0
  constructor(private initializeResult: Record<string, unknown> = {}) {
    super()
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) })
  }
  send(raw: string): void {
    const frame = JSON.parse(raw)
    if (typeof frame.id === 'number') queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: frame.method === 'initialize' ? this.initializeResult : {} }),
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

test('a live owner from an older Codex installation is replaced before it can receive new models', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-owner-version-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ownerFile = join(dir, 'owner.json')
  await writeFile(ownerFile, JSON.stringify({ pid: 4343, port: 54326, generation: 'old-version' }))
  let spawned = 0, oldAlive = true, socket = 0
  const killed: number[] = []
  const child = Object.assign(new EventEmitter(), {
    pid: 4444, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true },
  })
  const server = new CodexAppServer({
    bin: '/codex', ownerFile, port: 54327,
    binaryVersion: async () => '0.156.1',
    spawnImpl: (() => { spawned++; return child }) as never,
    inspectProcess: async pid => pid === 4343 && oldAlive
      ? 'UNMUTE_APP_SERVER=1 /codex app-server --listen ws://127.0.0.1:54326'
      : pid === 4444 ? 'UNMUTE_APP_SERVER=1 /codex app-server --listen ws://127.0.0.1:54327' : null,
    killImpl: pid => { killed.push(pid); if (pid === 4343) oldAlive = false },
    fetchImpl: async () => ({ ok: true }) as Response,
    wsFactory: () => new FakeSocket({ userAgent: socket++ === 0 ? 'unmute/0.153.2 (Mac OS; arm64)' : 'unmute/0.156.1 (Mac OS; arm64)' }) as never,
  } as any)

  await server.start()

  assert.deepEqual(killed, [4343])
  assert.equal(spawned, 1)
  assert.equal(JSON.parse(await readFile(ownerFile, 'utf8')).pid, 4444)
  server.stop()
})

test('a running app-server is replaced after Codex updates in place', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-owner-live-update-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ownerFile = join(dir, 'owner.json')
  let installedVersion = '0.153.2', nextPid = 4545
  const alive = new Set<number>()
  const killed: number[] = []
  const server = new CodexAppServer({
    bin: '/codex', ownerFile, port: 54328,
    binaryVersion: async () => installedVersion,
    spawnImpl: (() => {
      const pid = nextPid++
      alive.add(pid)
      return Object.assign(new EventEmitter(), {
        pid, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { alive.delete(pid); return true },
      })
    }) as never,
    inspectProcess: async pid => alive.has(pid) ? `UNMUTE_APP_SERVER=1 /codex app-server --listen ws://127.0.0.1:54328` : null,
    killImpl: pid => { killed.push(pid); alive.delete(pid) },
    fetchImpl: async () => ({ ok: true }) as Response,
    wsFactory: () => new FakeSocket({ userAgent: `unmute/${installedVersion} (Mac OS; arm64)` }) as never,
  } as any)

  await server.start()
  installedVersion = '0.156.1'
  assert.equal(await server.upgradeAvailable(), true)
  await server.restart()

  assert.deepEqual(killed, [4545])
  assert.equal(JSON.parse(await readFile(ownerFile, 'utf8')).pid, 4546)
  server.stop()
})

test('a verified live but unreachable owner is reaped before one replacement is spawned', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-owner-fence-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ownerFile = join(dir, 'owner.json')
  await writeFile(ownerFile, JSON.stringify({ pid: 5252, port: 54322, generation: 'live-owner' }))
  let spawned = 0, alive = true
  const killed: number[] = []
  const groupSignals: number[] = []
  const child = Object.assign(new EventEmitter(), {
    pid: 5353, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true },
  })
  const server = new CodexAppServer({
    bin: '/codex', ownerFile, port: 54323,
    spawnImpl: (() => { spawned++; return child }) as never,
    inspectProcess: async pid => pid === 5252 && alive ? 'UNMUTE_APP_SERVER=1 /codex app-server --listen ws://127.0.0.1:54322' : null,
    killProcessGroupImpl: pid => {
      groupSignals.push(pid)
      throw Object.assign(new Error('not a process-group leader'), { code: 'ESRCH' })
    },
    killImpl: pid => { killed.push(pid); alive = false },
    fetchImpl: async url => String(url).includes('54322') ? Promise.reject(new Error('connection refused')) : ({ ok: true }) as Response,
    wsFactory: () => new FakeSocket() as never,
    readyTimeoutMs: 5, readyPollMs: 1,
  })
  await server.start()
  assert.deepEqual(groupSignals, [5252])
  assert.deepEqual(killed, [5252])
  assert.equal(spawned, 1)
  assert.equal(JSON.parse(await readFile(ownerFile, 'utf8')).pid, 5353)
  server.stop()
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

test('startup reaps only unreferenced parentless Unmute app-server trees', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-legacy-orphans-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ownerDir = join(dir, 'continuity-v4', 'codex')
  await mkdir(ownerDir, { recursive: true })
  await writeFile(join(ownerDir, 'app-server-owner.json'), JSON.stringify({ pid: 300, port: 54330, generation: 'owned' }))
  const processes = [
    { pid: 100, ppid: 1, command: 'node /codex app-server --listen ws://127.0.0.1:54310' },
    { pid: 101, ppid: 100, command: '/native/codex app-server --listen ws://127.0.0.1:54310' },
    { pid: 200, ppid: 999, command: 'node /codex app-server --listen ws://127.0.0.1:54320' },
    { pid: 300, ppid: 1, command: 'node /codex app-server --listen ws://127.0.0.1:54330' },
    { pid: 301, ppid: 300, command: '/native/codex app-server --listen ws://127.0.0.1:54330' },
  ]
  const alive = new Set(processes.map(process => process.pid))
  const killed: number[] = []
  let rootSignalled = false
  let exitChecks = 0

  const reaped = await (CodexAppServer as any).reapUnreferencedStrays(dir, {
    listProcesses: async () => processes,
    inspectProcess: async (pid: number) => {
      if (pid === 100 && rootSignalled && ++exitChecks >= 2) alive.delete(pid)
      return alive.has(pid) ? `UNMUTE_APP_SERVER=1 ${processes.find(process => process.pid === pid)?.command}` : null
    },
    killImpl: (pid: number) => { killed.push(pid); if (pid === 100) rootSignalled = true; else alive.delete(pid) },
    exitTimeoutMs: 100,
    exitPollMs: 1,
  })

  assert.deepEqual(reaped, [101, 100])
  assert.deepEqual(killed, [101, 100])
  assert.ok(exitChecks >= 2, 'cleanup waits until the old writer has actually exited')
})

test('startup refuses to release its gate while a signalled writer remains alive', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-stuck-orphan-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const process = { pid: 700, ppid: 1, command: 'node /codex app-server --listen ws://127.0.0.1:54700' }

  await assert.rejects(CodexAppServer.reapUnreferencedStrays(dir, {
    listProcesses: async () => [process],
    inspectProcess: async () => `UNMUTE_APP_SERVER=1 ${process.command}`,
    killImpl: () => {},
    exitTimeoutMs: 5,
    exitPollMs: 1,
  }), /did not exit/)
})

test('a failed writer cleanup never starts the persistent runtime', async () => {
  let started = 0
  const cleanupFailure = Promise.reject(new Error('writer remains alive'))

  await assert.rejects(CodexAppServer.gateRuntimeStartup(cleanupFailure, async () => {
    started++
    return { pid: 1 }
  }), /writer remains alive/)

  assert.equal(started, 0)
})
