import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskManager } from './task-manager'
import { registerTaskImagePaste } from './task-attachment-paste'
import type { AgentExecutor } from './executor'

test('a CLI draft is composed with real Ctrl-V images before one submit', async () => {
  const trace: string[] = []
  const ex: AgentExecutor = {
    alive: true,
    async spawn() {}, async isReady() { trace.push('ready') },
    writeStdin(text) { trace.push(`legacy:${text}`) },
    writeDraftText(text) { trace.push(`text:${text}`) },
    async pasteImage() { trace.push('ctrl-v'); return true },
    submitDraft() { trace.push('submit') },
    write() {}, resize() {}, onData() {}, kill() {},
  }
  registerTaskImagePaste(async (_text, paths, paste) => {
    for (const path of paths) {
      trace.push(`clipboard:${path}`)
      if (!(await paste())) return false
    }
    return true
  })
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-attachments-'))
  const manager = new TaskManager({ executorFactory: () => ex, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, verifyAfterMs: 100, pollMs: 99_999 })
  const id = await manager.dispatch('initial')
  trace.length = 0
  ex.submitDraft = () => {
    trace.push('submit')
    manager.onHookEvent({ kind: 'prompt-submitted', sessionId: manager.get(id)!.sessionId })
  }

  assert.equal(await manager.deliverDraft(id, 'compare these', ['/tmp/one.png', '/tmp/two.png']), true)
  assert.deepEqual(trace, [
    'ready', 'text:compare these',
    'clipboard:/tmp/one.png', 'ctrl-v',
    'clipboard:/tmp/two.png', 'ctrl-v',
    'submit',
  ])
  assert.equal(trace.some((step) => step.includes('[image:')), false)
  manager.kill(id)
})

test('a rejected CLI image leaves the draft unsubmitted', async () => {
  const trace: string[] = []
  const ex: AgentExecutor = {
    alive: true,
    async spawn() {}, async isReady() {}, writeStdin() {},
    writeDraftText(text) { trace.push(`text:${text}`) },
    async pasteImage() { trace.push('ctrl-v'); return false },
    submitDraft() { trace.push('submit') },
    clearDraft() { trace.push('clear') },
    write() {}, resize() {}, onData() {}, kill() {},
  }
  registerTaskImagePaste(async (_text, _paths, paste) => paste())
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-attachments-'))
  const manager = new TaskManager({ executorFactory: () => ex, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, verifyAfterMs: 20, pollMs: 99_999 })
  const id = await manager.dispatch('initial')

  assert.equal(await manager.deliverDraft(id, 'keep me', ['/tmp/one.png']), false)
  assert.deepEqual(trace, ['text:keep me', 'ctrl-v', 'clear'])
  assert.match(manager.get(id)?.deliveryError ?? '', /attachment/i)
  manager.kill(id)
})

test('an unconfirmed CLI submit keeps the attachment draft retryable', async () => {
  const trace: string[] = []
  const ex: AgentExecutor = {
    alive: true,
    async spawn() {}, async isReady() {}, writeStdin() {},
    writeDraftText() {}, async pasteImage() { return true },
    submitDraft() { trace.push('submit') },
    write() {}, resize() {}, onData() {}, kill() {},
  }
  registerTaskImagePaste(async (_text, _paths, paste) => paste())
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-attachments-'))
  const manager = new TaskManager({ executorFactory: () => ex, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, verifyAfterMs: 20, pollMs: 99_999 })
  const id = await manager.dispatch('initial')

  assert.equal(await manager.deliverDraft(id, 'keep me', ['/tmp/one.png']), false)
  assert.deepEqual(trace, ['submit', 'submit'])
  assert.match(manager.get(id)?.deliveryError ?? '', /confirm/i)
  manager.kill(id)
})
