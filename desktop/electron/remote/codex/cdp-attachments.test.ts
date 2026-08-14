import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexCdp } from './cdp'
import { CodexDesktopDriver } from './driver'

test('attachments use the existing DOM file input without opening a chooser', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const cdp = Object.create(CodexCdp.prototype) as any
  cdp.send = async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params })
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
    if (method === 'DOM.querySelector') return { nodeId: 9 }
    return {}
  }
  cdp.waitForAttachedFiles = async () => true
  cdp.clickAriaLabel = async () => { throw new Error('chooser must not open') }

  assert.equal(await cdp.attachFiles(['/tmp/one.png']), true)
  assert.deepEqual(calls, [
    { method: 'DOM.getDocument', params: { depth: 0 } },
    { method: 'DOM.querySelector', params: { nodeId: 1, selector: 'input[type="file"]' } },
    { method: 'DOM.setFileInputFiles', params: { nodeId: 9, files: ['/tmp/one.png'] } },
  ])
})

test('attachments are accepted through an intercepted CDP chooser without opening a native picker', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const clicks: string[] = []
  const cdp = Object.create(CodexCdp.prototype) as any
  cdp.send = async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params })
  }
  cdp.clickAriaLabel = async (label: string) => { clicks.push(label); return true }
  cdp.clickText = async (label: string) => { clicks.push(label); return true }
  cdp.waitForEvent = async (method: string) => {
    assert.equal(method, 'Page.fileChooserOpened')
    return { backendNodeId: 42, mode: 'selectMultiple' }
  }
  cdp.waitForAttachedFiles = async (paths: readonly string[]) => paths.length === 2

  assert.equal(await cdp.attachFiles(['/tmp/one.png', '/tmp/two.png']), true)
  assert.deepEqual(clicks, ['Attach files or connect apps', 'Attach files or folders'])
  assert.deepEqual(calls, [
    { method: 'DOM.getDocument', params: { depth: 0 } },
    { method: 'Page.setInterceptFileChooserDialog', params: { enabled: true } },
    { method: 'Page.handleFileChooser', params: { action: 'accept', files: ['/tmp/one.png', '/tmp/two.png'], backendNodeId: 42 } },
    { method: 'Page.setInterceptFileChooserDialog', params: { enabled: false } },
  ])
})

test('attachment delivery is not accepted until Codex clears the submitted composer', async () => {
  const driver = new CodexDesktopDriver({ sleep: async () => {} }) as any
  driver.snapshot = async () => ({ turnsStarted: 4 })
  driver.cdp = {
    connected: true,
    focusComposer: async () => true,
    attachFiles: async () => true,
    typeText: async () => {},
    composerText: async () => 'send this',
    pressEnter: async () => {},
  }
  driver.openThread = async () => true

  assert.deepEqual(
    await driver.sendWithAttachments('thread-1', 'send this', ['/tmp/one.png']),
    { ok: false, reason: 'send-failed' },
  )
})

test('attachment-only delivery waits for the attachment preview to clear', async () => {
  let snapshotReads = 0
  const driver = new CodexDesktopDriver({ sleep: async () => {} }) as any
  driver.snapshot = async () => ({ turnsStarted: ++snapshotReads < 4 ? 4 : 5 })
  driver.cdp = {
    connected: true,
    focusComposer: async () => true,
    attachFiles: async () => true,
    typeText: async () => {},
    composerText: async () => '',
    pressEnter: async () => {},
  }
  driver.openThread = async () => true

  assert.deepEqual(
    await driver.sendWithAttachments('thread-1', '', ['/tmp/one.png']),
    { ok: true },
  )
  assert.equal(snapshotReads, 4, 'an already-empty text box is not submission proof')
})

test('Codex attachment delivery reports every CDP boundary to the correlated observer', async () => {
  const stages: string[] = []
  let snapshotReads = 0
  const driver = new CodexDesktopDriver({ sleep: async () => {} }) as any
  driver.snapshot = async () => ({ turnsStarted: ++snapshotReads < 3 ? 4 : 5 })
  driver.cdp = {
    connected: true,
    focusComposer: async () => true,
    attachFiles: async () => true,
    typeText: async () => {},
    composerText: async () => 'send this',
    pressEnter: async () => {},
  }
  driver.openThread = async () => true

  const result = await driver.sendWithAttachments(
    'thread-1', 'send this', ['/tmp/one.png'],
    (stage: string) => { stages.push(stage) },
  )
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(stages, [
    'cdp-connect', 'thread-open', 'baseline-read', 'composer-focused',
    'files-attached', 'text-typed', 'text-verified', 'submit-key', 'rollout-confirmed',
  ])
})

test('closing CDP rejects an outstanding file chooser wait instead of leaving delivery hung', async () => {
  const cdp = Object.create(CodexCdp.prototype) as any
  cdp.ws = { close() {} }
  cdp.pending = new Map()
  cdp.eventWaiters = new Map()

  const outcome = Promise.race([
    cdp.waitForEvent('Page.fileChooserOpened', 5_000).then(
      () => 'resolved',
      (error: Error) => error.message,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 30)),
  ])
  cdp.close()

  assert.equal(await outcome, 'CDP closed')
})
