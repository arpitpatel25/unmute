// Typed input on the Orchestrator and Agent lanes.
//
// What got the first attempt reverted is written down here as tests: typing is
// for ONE invocation (the next press is a microphone again), a cancelled typed
// capture leaves nothing behind, and the typed text goes where a transcript
// goes — not through a second delivery path of its own.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

type Dispatch = { text: string; target: unknown; options: { route?: string } }

// ONE module load for the whole file: `import()` is cached, so the stubs — and
// the arrays they write into — are the first load's for every test. Each test
// gets a fresh manager and emptied arrays instead.
const widget: unknown[][] = []
const dispatched: Dispatch[] = []
const covered: string[] = []
let SessionManagerClass: typeof import('./sessionManager').SessionManager | null = null

async function loadSessionManager(): Promise<typeof import('./sessionManager').SessionManager> {
  if (SessionManagerClass) return SessionManagerClass
  const require = createRequire(import.meta.url)
  const Module = require('node:module') as { _load: (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown }
  const originalLoad = Module._load
  let nextSession = 0
  const noop = () => undefined
  const moduleStub = new Proxy<Record<string, unknown>>({}, { get: () => noop })
  Module._load = function loadForSessionManager(request, parent, isMain) {
    if (parent?.filename?.endsWith('/engine-overrides/electron/sessionManager.ts')) {
      if (request === 'uuid') return { v4: () => `session-${++nextSession}` }
      if (request === 'electron') return { app: { isPackaged: true, getPath: () => '/tmp', getVersion: () => 'test' } }
      if (request === './windowManager') return {
        showHUD: noop, hideHUD: noop, cancelPendingHide: noop,
        getWidgetWindow: () => ({ webContents: { send: (...args: unknown[]) => widget.push(args) } }),
      }
      if (request === './paywall/remote/init') return {
        dispatchFromCapture: async (text: string, _attachments: unknown, target: unknown, options: Dispatch['options']) => {
          dispatched.push({ text, target, options }); return null
        },
        hideNativePill: noop,
        recordCapturedDictation: noop,
      }
      if (request === './paywall/remote/capture/index') return new Proxy<Record<string, unknown>>({
        dropInsertsCoveredBy: (text: string) => { covered.push(text); return 0 },
        composeWithInserts: () => null,
        isArmed: () => false,
      }, { get: (target, key) => (key in target ? target[key as string] : noop) })
      if (request === './sttArbiter') return { SttArbiter: class { dispose() {} recordingStarted() {} recordingEnded() {} } }
      if (request === './featureFlags') return { features: { localModels: false } }
      if (request === './dictationTelemetry') return { DEV_BUILD: false, initTelemetry: noop, logTelemetry: noop, installMainConsoleTee: noop, attachRendererConsoleTee: noop }
      if (request === './parakeet') return { parakeetManager: { isAvailable: () => false, isModelReady: () => false, isBinaryReady: () => false } }
      if (request === './fasterWhisper') return { fasterWhisperManager: { isReady: () => false } }
      if (request === './errorUtils') return { simplifyError: (error: string) => error }
      if (request === './quietGuard') return { isSuspectQuietCapture: () => false }
      if (request === './remoteDispatchQueue') return originalLoad.call(this, request, parent, isMain)
      if (request === './captureRoute') return originalLoad.call(this, request, parent, isMain)
      if (request.startsWith('./')) return moduleStub
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  try { SessionManagerClass = (await import('./sessionManager')).SessionManager }
  finally { Module._load = originalLoad }
  return SessionManagerClass
}

async function harness(t: test.TestContext) {
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = () => {}
  console.warn = () => {}
  t.after(() => { console.log = originalLog; console.warn = originalWarn })
  widget.length = 0
  dispatched.length = 0
  covered.length = 0
  const SessionManager = await loadSessionManager()
  const manager = new SessionManager()
  let ended = 0
  manager.onSessionEnded = () => { ended++ }
  t.after(() => { if (manager.getCurrentSession()) manager.cancelSession() })
  const settle = () => new Promise((r) => setTimeout(r, 20))
  return { manager, widget, dispatched, covered, settle, ended: () => ended }
}

test('an Agent capture switched to typing delivers the typed words, exactly, to the Agent', async (t) => {
  const { manager, widget, dispatched, covered, settle } = await harness(t)
  manager.startRemoteCapture(null, true)
  const id = manager.getCurrentSession()!.sessionId
  assert.equal(await manager.beginTypedInput(), id)
  assert.deepEqual(widget.find((e) => e[0] === 'pill:event')?.[1], { type: 'typing', value: id },
    'the recorder is told to let go of the microphone, for this session')

  // Whatever the recorder sends on its way out is refused, and its silence
  // verdict does not end the capture being typed.
  manager.receiveAudio(Buffer.from('heard before the switch'), 400, 'dictation', id)
  manager.receiveAudioChunk(Buffer.from('chunk'), 0, 'dictation', id)
  assert.equal(manager.getCurrentSession()!.dictationAudio, null)
  manager.discardSession(id)
  assert.equal(manager.getCurrentSession()?.sessionId, id, 'a silence verdict cannot end a typed capture')

  assert.equal(manager.setTypedDraft('someone-else', 'no'), false)
  assert.equal(manager.setTypedDraft(id, '  Summarise the thread. Thank you.  '), true)
  await manager.stopRemoteCapture()
  await settle()
  assert.equal(dispatched.length, 1)
  // No STT scrub: a sincere trailing "Thank you." is not a Whisper artefact.
  assert.equal(dispatched[0].text, 'Summarise the thread. Thank you.')
  assert.equal(dispatched[0].options.route, 'agent')
  assert.deepEqual(covered, ['Summarise the thread. Thank you.'], 'captured inserts are de-duplicated against the text')
  assert.equal(manager.getCurrentSession(), null)
  assert.equal(manager.processing, false)
})

test('typing is per invocation: the next press opens the microphone', async (t) => {
  const { manager, widget } = await harness(t)
  manager.startRemoteCapture(null, true)
  await manager.beginTypedInput()
  manager.cancelSession()
  widget.length = 0
  manager.startRemoteCapture(null, true)
  assert.equal(manager.getCurrentSession()!.typed, undefined)
  assert.equal(manager.typingSessionId, null)
  assert.ok(widget.some((e) => e[0] === 'recording:start'), 'the recorder is started for the new capture')
})

test('a cancelled typed capture delivers nothing and its draft cannot be revived', async (t) => {
  const { manager, dispatched, settle, ended } = await harness(t)
  manager.startRemoteCapture(null, false)
  const id = (await manager.beginTypedInput())!
  manager.setTypedDraft(id, 'never mind')
  manager.cancelSession()
  assert.equal(ended(), 1, 'the ending is announced, which is what closes the box')
  assert.equal(manager.setTypedDraft(id, 'late'), false)
  await manager.stopRemoteCapture()
  await settle()
  assert.deepEqual(dispatched, [])
})

test('Escape on a typed capture is a plain cancel — there is no audio to undo into', async (t) => {
  const { manager, dispatched, settle } = await harness(t)
  manager.startRemoteCapture(null, true)
  const id = (await manager.beginTypedInput())!
  manager.setTypedDraft(id, 'draft')
  manager.cancelSessionWithUndo()
  manager.undoCancel()
  await settle()
  assert.equal(manager.getCurrentSession(), null)
  assert.deepEqual(dispatched, [])
})

test('a selection taken at the switch rides along as a quote, like the voice quote flow', async (t) => {
  const { manager, dispatched, settle } = await harness(t)
  manager.startRemoteCapture(null, true)
  const id = (await manager.beginTypedInput())!
  manager.getCurrentSession()!.selectedText = 'the selected paragraph'
  manager.setTypedDraft(id, 'explain this')
  await manager.stopRemoteCapture()
  await settle()
  assert.equal(dispatched[0].text, '> the selected paragraph\n\nexplain this')
})

test('typing is offered on the Orchestrator and Agent lanes only', async (t) => {
  const { manager } = await harness(t)
  assert.equal(await manager.beginTypedInput(), null, 'nothing is recording')
  manager.startSession('dictation')
  assert.equal(await manager.beginTypedInput(), null, 'plain dictation pastes at the cursor')
  manager.cancelSession()
  manager.startRemoteCapture('task-1', false, { token: 'composer', taskId: 'task-1' } as never)
  assert.equal(await manager.beginTypedInput(), null, 'dictating into a composer is already typing')
})

test('a typed capture may move between Orchestrator and Agent, never to the cursor', async (t) => {
  const { manager } = await harness(t)
  manager.startRemoteCapture(null, false)
  await manager.beginTypedInput()
  assert.equal(manager.setCaptureRoute('cursor'), false)
  assert.equal(manager.setCaptureRoute('agent'), true)
  assert.equal(manager.getCurrentSession()!.route, 'agent')
})
