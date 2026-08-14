import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskManager } from './task-manager'
import { registerTaskImagePaste } from './task-attachment-paste'
import type { AgentExecutor } from './executor'
import type { TaskReplyTrace } from './task-reply-trace'
import { setConsoleMirror } from './log'

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

test('a text-only CLI task draft uses the same verified composer submission path', async () => {
  const trace: string[] = []
  const ex: AgentExecutor = {
    alive: true,
    async spawn() {}, async isReady() { trace.push('ready') },
    writeStdin(text) { trace.push(`legacy:${text}`) },
    writeDraftText(text) { trace.push(`text:${text}`) },
    async pasteImage() { throw new Error('no image expected') },
    submitDraft() { trace.push('submit') },
    write() {}, resize() {}, onData() {}, kill() {},
  }
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-attachments-'))
  const manager = new TaskManager({ executorFactory: () => ex, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, verifyAfterMs: 100, pollMs: 99_999 })
  const id = await manager.dispatch('initial')
  trace.length = 0
  ex.submitDraft = () => {
    trace.push('submit')
    manager.onHookEvent({ kind: 'prompt-submitted', sessionId: manager.get(id)!.sessionId })
  }

  assert.equal(await manager.deliverDraft(id, 'next prompt', []), true)
  assert.deepEqual(trace, ['ready', 'text:next prompt', 'submit'])
  manager.kill(id)
})

test('an unconfirmed text-only CLI task draft is not reported as delivered', async () => {
  const ex: AgentExecutor = {
    alive: true,
    async spawn() {}, async isReady() {}, writeStdin() {}, writeDraftText() {},
    async pasteImage() { return true }, submitDraft() {},
    write() {}, resize() {}, onData() {}, kill() {},
  }
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-attachments-'))
  const manager = new TaskManager({ executorFactory: () => ex, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, verifyAfterMs: 20, pollMs: 99_999 })
  const id = await manager.dispatch('initial')

  assert.equal(await manager.deliverDraft(id, 'keep this', []), false)
  assert.match(manager.get(id)?.deliveryError ?? '', /confirm/i)
  manager.kill(id)
})

test('a Codex app-server text draft uses the structured turn transport, not its terminal view', async () => {
  const sends: Array<{ text: string; attachments: readonly string[] | undefined }> = []
  const hub = {
    async startThread() { return { threadId: 'codex-thread', url: 'ws://test' } },
    threadIdFor() { return 'codex-thread' },
    async send(_id: string, text: string, opts: { attachments?: readonly string[] } = {}) {
      sends.push({ text, attachments: opts.attachments })
      return true
    },
  }
  const terminalWrites: string[] = []
  const ex: AgentExecutor = {
    alive: true, async spawn() {}, async isReady() {},
    writeStdin(text) { terminalWrites.push(text) }, write() {}, resize() {}, onData() {}, kill() {},
  }
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-attachments-'))
  const manager = new TaskManager({
    executorFactory: () => ex, codexHub: hub as never, baseDir,
    trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 99_999,
  })
  const id = await manager.dispatch('initial', { agent: 'codex' })
  sends.length = 0
  terminalWrites.length = 0

  assert.equal(await manager.deliverDraft(id, 'next prompt', []), true)
  assert.deepEqual(sends, [{ text: 'next prompt', attachments: [] }])
  assert.deepEqual(terminalWrites, [])
  manager.killAll()
})

test('provider delivery logs the exact correlated transport and task configuration in dev builds', async () => {
  const previousFlag = process.env.UNMUTE_CURATOR_DEVLOG
  const previousLog = console.log
  const lines: string[] = []
  process.env.UNMUTE_CURATOR_DEVLOG = '1'
  setConsoleMirror(true)
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  const hub = {
    async startThread() { return { threadId: 'codex-thread', url: 'ws://test' } },
    threadIdFor() { return 'codex-thread' },
    async send() { return true },
  }
  const ex: AgentExecutor = {
    alive: true, async spawn() {}, async isReady() {}, writeStdin() {},
    write() {}, resize() {}, onData() {}, kill() {},
  }
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-attachments-'))
  const manager = new TaskManager({
    executorFactory: () => ex, codexHub: hub as never, baseDir,
    codexCliChoice: () => ({ model: 'gpt-5.6-sol', effort: 'high' }),
    permissionMode: () => 'auto-approve', codexFullAccess: () => true,
    trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 99_999,
  })
  try {
    const id = await manager.dispatch('initial', { agent: 'codex', model: 'gpt-5.6-sol high' })
    lines.length = 0
    const trace: TaskReplyTrace = {
      attemptId: 'attempt-correlated', taskId: id, draftId: 'draft-correlated',
      source: 'right-option', startedAt: Date.now(), now: Date.now,
    }
    assert.equal(await manager.deliverDraft(id, 'next prompt', [], trace), true)
    const joined = lines.join('\n')
    assert.match(joined, /task-reply-trace/)
    assert.match(joined, /attempt-correlated/)
    assert.match(joined, /provider-selected/)
    assert.match(joined, /codex-app-server/)
    assert.match(joined, /gpt-5\.6-sol high/)
    assert.match(joined, /auto-approve/)
    assert.match(joined, /transport-result/)
  } finally {
    manager.killAll()
    setConsoleMirror(false)
    console.log = previousLog
    if (previousFlag === undefined) delete process.env.UNMUTE_CURATOR_DEVLOG
    else process.env.UNMUTE_CURATOR_DEVLOG = previousFlag
  }
})
