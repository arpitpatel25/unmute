import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskManager } from './task-manager.ts'

async function base(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'unmute-continuity-'))
}

function executorFactory(): never {
  throw new Error('continuity must not use a terminal executor')
}

test('Codex attach resumes the exact provider thread and submits only the current request', async () => {
  const baseDir = await base()
  const calls: Array<{ op: string; value?: string }> = []
  const threads = new Map<string, string>()
  const hub = {
    running: true,
    async resumeThread(taskId: string, threadId: string) {
      if (threads.get(taskId) === threadId) return
      calls.push({ op: 'resume', value: threadId }); threads.set(taskId, threadId)
    },
    async send(_taskId: string, text: string) { calls.push({ op: 'send', value: text }); return true },
    threadIdFor(taskId: string) { return threads.get(taskId) },
  }
  const tm = new TaskManager({ executorFactory, codexHub: hub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })

  const result = await tm.attachProviderSession({
    harness: 'codex', sessionId: 'source-thread', cwd: baseDir, intent: 'add the pricing row',
  })

  assert.equal(result.sessionId, 'source-thread')
  assert.deepEqual(calls, [
    { op: 'resume', value: 'source-thread' },
    { op: 'send', value: 'add the pricing row' },
  ])
  assert.equal(tm.get(result.taskId)?.continuationMode, 'resume')
  assert.deepEqual(tm.get(result.taskId)?.continuationSources, [
    { sessionId: 'source-thread', provider: 'codex' },
  ])
  const durable = JSON.parse(await fs.readFile(join(tm.get(result.taskId)!.home, 'meta.json'), 'utf8'))
  assert.equal(durable.intent, 'add the pricing row')
  assert.equal(durable.chatUnstarted, false)
  assert.equal(durable.continuationMode, 'resume')
  assert.deepEqual(durable.continuationSources, [{ sessionId: 'source-thread', provider: 'codex' }])
})

test('unknown legacy Codex conversation is claimed only after exact provider resume succeeds', async () => {
  const baseDir = await base()
  const firstHub = { running: true, threadIdFor() { return undefined } }
  const first = new TaskManager({ executorFactory, codexHub: firstHub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })
  const id = await first.createChat({ provider: 'codex', cwd: baseDir, permission: 'maximum' })
  const task = first.get(id)!, home = task.home
  const meta = JSON.parse(await fs.readFile(join(home, 'meta.json'), 'utf8'))
  meta.sessionId = 'legacy-thread'; meta.codexRolloutId = 'legacy-thread'; meta.chatUnstarted = false
  delete meta.codexSessionSettings; delete meta.sessionOwnership
  await fs.writeFile(join(home, 'meta.json'), JSON.stringify(meta))

  const calls: string[] = []
  let activeWriter = true
  const hub = {
    running: true,
    async resumeThread(_taskId: string, threadId: string) {
      calls.push(threadId)
      if (activeWriter) throw new Error('thread already has an active writer')
    },
    threadIdFor() { return undefined },
  }
  const restarted = new TaskManager({ executorFactory, codexHub: hub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })
  await restarted.rehydrate()
  assert.equal(restarted.get(id)?.sessionOwnership, 'unknown')
  assert.equal(restarted.get(id)?.agent, 'codex')
  assert.equal(await restarted.resume(id), false)
  const refused = JSON.parse(await fs.readFile(join(home, 'meta.json'), 'utf8'))
  assert.equal(refused.sessionOwnership, undefined)
  assert.equal(refused.codexSessionSettings, undefined)
  activeWriter = false
  assert.equal(await restarted.resume(id), true, restarted.get(id)?.deliveryError ?? restarted.get(id)?.resumeError)
  assert.deepEqual(calls, ['legacy-thread', 'legacy-thread'])
  assert.equal(restarted.get(id)?.deliveryError, undefined)
  assert.equal(restarted.get(id)?.resumeError, undefined)
  const adopted = JSON.parse(await fs.readFile(join(home, 'meta.json'), 'utf8'))
  assert.equal(adopted.sessionOwnership, 'unmute')
  assert.ok(adopted.codexSessionSettings)
})

test('Codex reopen attaches exact history without inventing a user turn', async () => {
  const baseDir = await base()
  const calls: string[] = []
  const threads = new Map<string, string>()
  const hub = {
    running: true,
    async resumeThread(taskId: string, threadId: string) {
      if (threads.get(taskId) === threadId) return
      calls.push(`resume:${threadId}`); threads.set(taskId, threadId)
    },
    async send() { calls.push('send'); return true },
    threadIdFor(taskId: string) { return threads.get(taskId) },
  }
  const tm = new TaskManager({ executorFactory, codexHub: hub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })

  const result = await tm.attachProviderSession({ harness: 'codex', sessionId: 'source-thread', cwd: baseDir })

  assert.equal(result.sessionId, 'source-thread')
  assert.deepEqual(calls, ['resume:source-thread'])
})

test('restart repairs a persisted Codex identity that was incorrectly left unstarted', async () => {
  const baseDir = await base()
  const hub = { running: true, threadIdFor() { return undefined } }
  const initial = new TaskManager({ executorFactory, codexHub: hub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })
  const id = await initial.createChat({ provider: 'codex', cwd: baseDir })
  const home = initial.get(id)!.home
  const broken = JSON.parse(await fs.readFile(join(home, 'meta.json'), 'utf8'))
  broken.sessionId = 'forked-child'; broken.codexRolloutId = 'forked-child'; broken.chatUnstarted = true
  await fs.writeFile(join(home, 'meta.json'), JSON.stringify(broken))

  const restarted = new TaskManager({ executorFactory, codexHub: hub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })
  await restarted.rehydrate()
  assert.notEqual(restarted.get(id)?.chatUnstarted, true)
  assert.equal(JSON.parse(await fs.readFile(join(home, 'meta.json'), 'utf8')).chatUnstarted, false)
})

test('Codex fork uses native fork and persists the returned child and source', async () => {
  const baseDir = await base()
  const calls: Array<{ op: string; value?: string }> = []
  const threads = new Map<string, string>()
  const hub = {
    running: true,
    async forkThread(taskId: string, source: string) {
      calls.push({ op: 'fork', value: source }); threads.set(taskId, 'child-thread')
      return { threadId: 'child-thread', forkedFromId: source }
    },
    async resumeThread() {},
    async send(_taskId: string, text: string) { calls.push({ op: 'send', value: text }); return true },
    threadIdFor(taskId: string) { return threads.get(taskId) },
  }
  const tm = new TaskManager({ executorFactory, codexHub: hub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })

  const result = await tm.forkProviderSession({
    harness: 'codex', sessionId: 'source-thread', cwd: baseDir, intent: 'try another route',
  })

  assert.deepEqual(result, { taskId: result.taskId, sessionId: 'child-thread' })
  assert.deepEqual(calls, [
    { op: 'fork', value: 'source-thread' },
    { op: 'send', value: 'try another route' },
  ])
  assert.equal(tm.get(result.taskId)?.continuationMode, 'fork')
  assert.deepEqual(tm.get(result.taskId)?.continuationSources, [
    { sessionId: 'source-thread', provider: 'codex' },
  ])
  const durable = JSON.parse(await fs.readFile(join(tm.get(result.taskId)!.home, 'meta.json'), 'utf8'))
  assert.equal(durable.intent, 'try another route')
  assert.equal(durable.chatUnstarted, false)
  assert.equal(durable.continuationMode, 'fork')
  assert.deepEqual(durable.continuationSources, [{ sessionId: 'source-thread', provider: 'codex' }])
})

test('synthesis provenance survives task rehydration', async () => {
  const baseDir = await base()
  let sequence = 0
  const hub = {
    async startThread() { return { threadId: `thread-${++sequence}`, url: 'ws://localhost' } },
    async send() { return true },
    threadIdFor() { return undefined },
  }
  const options = { executorFactory, codexHub: hub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' as const }
  const first = new TaskManager(options)
  const taskId = await first.dispatch('continue the combined work', { agent: 'codex', kind: 'session', cwd: baseDir })
  first.mergeAgentOrigin(taskId, 'agent-run')
  await first.mergeContinuationProvenance(taskId, {
    mode: 'synthesis',
    sources: [{ sessionId: 'aaaaaaaa-1111-2222-8333-444444444444', provider: 'claude' }],
    artifacts: [{ kind: 'url', value: 'https://docs.example.test/brief', label: 'Brief' }],
  })
  const second = new TaskManager(options)
  await second.rehydrate()
  assert.equal(second.get(taskId)?.continuationMode, 'synthesis')
  assert.deepEqual(second.get(taskId)?.continuationSources, [
    { sessionId: 'aaaaaaaa-1111-2222-8333-444444444444', provider: 'claude' },
  ])
  assert.deepEqual(second.get(taskId)?.continuationArtifacts, [
    { kind: 'url', value: 'https://docs.example.test/brief', label: 'Brief' },
  ])
})
