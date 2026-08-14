import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexCdp } from './cdp'
import { CodexDesktopDriver, parseLsappinfoBundleId } from './driver'

test('frontmost-app fallback parses the bundle identifier reported by lsappinfo', () => {
  assert.equal(parseLsappinfoBundleId('"CFBundleIdentifier"="com.google.Chrome"\n'), 'com.google.Chrome')
  assert.equal(parseLsappinfoBundleId(''), null)
})

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

test('existing-task attachments use native clipboard paste after activating the exact Codex composer', async () => {
  const focus: string[] = []
  const stages: string[] = []
  let attachmentCount = 0
  let snapshotReads = 0
  const driver = new CodexDesktopDriver({
    sleep: async () => {},
    frontmost: async () => 'com.user.previousapp',
    activate: async (bundleId) => { focus.push(bundleId); return true },
    pasteImages: async (_text: string, paths: readonly string[], observe: (stage: string) => void) => {
      assert.deepEqual(paths, ['/tmp/one.png'])
      observe('pasteboard-written')
      observe('paste-posted')
      attachmentCount = 1
      return true
    },
  } as any) as any
  driver.snapshot = async () => ({ turnsStarted: ++snapshotReads < 3 ? 4 : 5 })
  driver.cdp = {
    connected: true,
    evaluate: async () => 'local:thread-1',
    focusComposer: async () => true,
    attachFiles: async () => { throw new Error('file input and chooser must not be used') },
    composerAttachmentCount: async () => attachmentCount,
    typeText: async () => {},
    composerText: async () => 'send this',
    pressEnter: async () => {},
  }
  driver.openThread = async () => true

  assert.deepEqual(
    await driver.sendWithAttachments(
      'thread-1', 'send this', ['/tmp/one.png'],
      (stage: string) => { stages.push(stage) },
    ),
    { ok: true },
  )
  assert.deepEqual(focus, ['com.openai.codex', 'com.user.previousapp'])
  assert.ok(stages.includes('clipboard-pasteboard-written'))
  assert.ok(stages.includes('clipboard-paste-posted'))
  assert.ok(stages.includes('attachment-preview-verified'))
  assert.ok(stages.indexOf('text-verified') < stages.indexOf('clipboard-paste-posted'))
  assert.ok(stages.indexOf('attachment-preview-verified') < stages.indexOf('submit-key'))
})

test('attachment delivery is not accepted until Codex clears the submitted composer', async () => {
  let attachmentCount = 0
  const driver = new CodexDesktopDriver({
    sleep: async () => {}, frontmost: async () => 'com.openai.codex', activate: async () => true,
    pasteImages: async () => { attachmentCount = 1; return true },
  }) as any
  driver.snapshot = async () => ({ turnsStarted: 4 })
  driver.cdp = {
    connected: true,
    evaluate: async () => 'local:thread-1',
    focusComposer: async () => true,
    composerAttachmentCount: async () => attachmentCount,
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
  let attachmentCount = 0
  const driver = new CodexDesktopDriver({
    sleep: async () => {}, frontmost: async () => 'com.openai.codex', activate: async () => true,
    pasteImages: async () => { attachmentCount = 1; return true },
  }) as any
  driver.snapshot = async () => ({ turnsStarted: ++snapshotReads < 4 ? 4 : 5 })
  driver.cdp = {
    connected: true,
    evaluate: async () => 'local:thread-1',
    focusComposer: async () => true,
    composerAttachmentCount: async () => attachmentCount,
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
  let attachmentCount = 0
  const driver = new CodexDesktopDriver({
    sleep: async () => {}, frontmost: async () => 'com.openai.codex', activate: async () => true,
    pasteImages: async () => { attachmentCount = 1; return true },
  }) as any
  driver.snapshot = async () => ({ turnsStarted: ++snapshotReads < 3 ? 4 : 5 })
  driver.cdp = {
    connected: true,
    evaluate: async () => 'local:thread-1',
    focusComposer: async () => true,
    composerAttachmentCount: async () => attachmentCount,
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
    'cdp-connect', 'focus-snapshot', 'thread-open', 'target-activated', 'baseline-read',
    'thread-identity-before-compose', 'composer-focused', 'text-typed', 'text-verified',
    'attachment-preview-baseline', 'attachment-paste-started', 'attachment-paste-completed',
    'attachment-preview-sample', 'attachment-preview-verified',
    'thread-identity-before-submit', 'submit-key', 'focus-restored', 'rollout-confirmed',
  ])
})

test('an off-screen Codex thread is opened exactly for delivery and the previous app is restored', async () => {
  const focus: string[] = []
  const stages: string[] = []
  let snapshotReads = 0
  let attachmentCount = 0
  const driver = new CodexDesktopDriver({
    sleep: async () => {},
    frontmost: async () => 'com.user.previousapp',
    activate: async (bundleId) => { focus.push(bundleId); return true },
    pasteImages: async () => { attachmentCount = 1; return true },
  }) as any
  driver.snapshot = async () => ({ turnsStarted: ++snapshotReads < 3 ? 4 : 5 })
  driver.cdp = {
    connected: true,
    evaluate: async () => 'local:thread-1',
    focusComposer: async () => true,
    composerAttachmentCount: async () => attachmentCount,
    typeText: async () => {},
    composerText: async () => 'send this',
    pressEnter: async () => {},
  }
  const opens: Array<boolean | undefined> = []
  driver.openThread = async (_threadId: string, _cdp: unknown, opts: { background?: boolean } = {}) => {
    opens.push(opts.background)
    return opts.background !== true
  }

  assert.deepEqual(
    await driver.sendWithAttachments(
      'thread-1', 'send this', ['/tmp/one.png'],
      (stage: string) => { stages.push(stage) },
    ),
    { ok: true },
  )
  assert.deepEqual(opens, [true, undefined])
  assert.deepEqual(focus, ['com.openai.codex', 'com.user.previousapp'])
  assert.ok(stages.includes('thread-open-background-miss'))
  assert.ok(stages.includes('thread-open-exact'))
  assert.ok(stages.includes('focus-restored'))
  assert.ok(
    stages.indexOf('focus-restored') < stages.indexOf('rollout-confirmed'),
    'Codex focus is needed only through Enter; rollout proof must not leave it foregrounded',
  )
})

test('an exact-navigation failure restores focus and leaves Codex delivery unaccepted', async () => {
  const focus: string[] = []
  const stages: string[] = []
  const driver = new CodexDesktopDriver({
    sleep: async () => {},
    frontmost: async () => 'com.user.previousapp',
    activate: async (bundleId) => { focus.push(bundleId); return true },
  }) as any
  driver.cdp = { connected: true }
  driver.openThread = async () => false

  assert.deepEqual(
    await driver.sendWithAttachments(
      'missing-thread', 'keep this', ['/tmp/one.png'],
      (stage: string) => { stages.push(stage) },
    ),
    { ok: false, reason: 'thread-not-found' },
  )
  assert.deepEqual(focus, ['com.user.previousapp'])
  assert.ok(stages.includes('thread-open-exact'))
  assert.ok(stages.includes('focus-restored'))
})

test('delivery refuses Enter when the mounted Codex thread drifts after composition', async () => {
  const stages: Array<{ stage: string; ok?: unknown }> = []
  let identityReads = 0
  let enterCount = 0
  let snapshotReads = 0
  let attachmentCount = 0
  const driver = new CodexDesktopDriver({
    sleep: async () => {}, frontmost: async () => 'com.openai.codex', activate: async () => true,
    pasteImages: async () => { attachmentCount = 1; return true },
  }) as any
  driver.snapshot = async () => ({ turnsStarted: ++snapshotReads < 2 ? 4 : 5 })
  driver.cdp = {
    connected: true,
    evaluate: async () => ++identityReads === 1 ? 'local:thread-1' : 'local:other-thread',
    focusComposer: async () => true,
    composerAttachmentCount: async () => attachmentCount,
    typeText: async () => {},
    composerText: async () => 'send this',
    pressEnter: async () => { enterCount++ },
  }
  driver.openThread = async () => true

  assert.deepEqual(
    await driver.sendWithAttachments(
      'thread-1', 'send this', ['/tmp/one.png'],
      (stage: string, fields: Record<string, unknown>) => stages.push({ stage, ok: fields.ok }),
    ),
    { ok: false, reason: 'thread-drifted' },
  )
  assert.equal(enterCount, 0)
  assert.deepEqual(stages.find((entry) => entry.stage === 'thread-identity-before-submit'), {
    stage: 'thread-identity-before-submit', ok: false,
  })
})

test('concurrent Codex replies cannot share one rollout acknowledgement', async () => {
  let baselineReads = 0
  let releaseProof: (() => void) | null = null
  let proofBlocked = false
  const driver = new CodexDesktopDriver({
    sleep: async (ms) => {
      if (ms === 200 && !proofBlocked) {
        proofBlocked = true
        await new Promise<void>((resolve) => { releaseProof = resolve })
      }
    },
  }) as any
  driver.snapshot = async () => ({ turnsStarted: baselineReads++ })
  driver.cdp = {
    connected: true,
    evaluate: async () => 'local:thread-1',
    focusComposer: async () => true,
    attachFiles: async () => true,
    typeText: async () => {},
    composerText: async () => 'send this',
    pressEnter: async () => {},
  }
  driver.openThread = async () => true

  const first = driver.sendWithAttachments('thread-1', 'send this', [])
  const second = driver.sendWithAttachments('thread-1', 'send this', [])
  for (let i = 0; i < 10 && !releaseProof; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(baselineReads, 1, 'the second baseline must wait for the first rollout proof')
  releaseProof?.()
  await Promise.all([first, second])
})

test('a Codex delivery exception is logged, restores focus, and returns a retained-draft failure', async () => {
  const focus: string[] = []
  const stages: string[] = []
  const driver = new CodexDesktopDriver({
    sleep: async () => {},
    frontmost: async () => 'com.user.previousapp',
    activate: async (bundleId) => { focus.push(bundleId); return true },
  }) as any
  driver.snapshot = async () => ({ turnsStarted: 4 })
  driver.cdp = {
    connected: true,
    evaluate: async () => 'local:thread-1',
    focusComposer: async () => { throw new Error('composer exploded') },
  }
  driver.openThread = async (_id: string, _cdp: unknown, opts: { background?: boolean } = {}) => opts.background !== true

  assert.deepEqual(
    await driver.sendWithAttachments(
      'thread-1', 'keep this', [],
      (stage: string) => stages.push(stage),
    ),
    { ok: false, reason: 'delivery-exception' },
  )
  assert.deepEqual(focus, ['com.user.previousapp'])
  assert.ok(stages.includes('focus-restored'))
  assert.ok(stages.includes('delivery-exception'))
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
