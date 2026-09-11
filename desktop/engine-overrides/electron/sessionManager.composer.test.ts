import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { ComposerDictationCoordinator } from '../../electron/remote/composer-dictation'

test('a cancelled capture late grace waiter cannot clear or deliver into its processing replacement', async t => {
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = () => {}
  console.warn = () => {}
  t.after(() => { console.log = originalLog; console.warn = originalWarn })
  const require = createRequire(import.meta.url)
  const Module = require('node:module') as { _load: (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown }
  const originalLoad = Module._load
  const dispatched: string[] = []
  let nextSession = 0
  let releaseFirstGraceCheck!: () => void
  const firstGraceCheck = new Promise<void>(resolve => { releaseFirstGraceCheck = resolve })
  let observedFirstGraceCheck = false

  const noop = () => undefined
  const moduleStub = new Proxy<Record<string, unknown>>({}, { get: () => noop })
  Module._load = function loadForSessionManager(request, parent, isMain) {
    if (parent?.filename?.endsWith('/engine-overrides/electron/sessionManager.ts')) {
      if (request === 'uuid') return { v4: () => `session-${++nextSession}` }
      if (request === 'electron') return { app: { isPackaged: true, getPath: () => '/tmp', getVersion: () => 'test' } }
      if (request === './paywall/remote/init') return {
        dispatchFromCapture: async (text: string) => { dispatched.push(text); return null },
        hideNativePill: noop,
        recordCapturedDictation: noop,
      }
      if (request === './sttArbiter') return {
        SttArbiter: class {
          dispose(): void {}
          recordingStarted(): void {}
          recordingEnded(): void {}
        },
      }
      if (request === './featureFlags') return { features: { localModels: false } }
      if (request === './dictationTelemetry') return { DEV_BUILD: false, initTelemetry: noop, logTelemetry: noop, installMainConsoleTee: noop, attachRendererConsoleTee: noop }
      if (request === './parakeet') return { parakeetManager: { isAvailable: () => false, isModelReady: () => false, isBinaryReady: () => false } }
      if (request === './fasterWhisper') return { fasterWhisperManager: { isReady: () => false } }
      if (request === './graceWait') return {
        GRACE_WINDOW_MS: 10,
        graceVerdict: ({ stillCurrent }: { stillCurrent: boolean }) => {
          if (!observedFirstGraceCheck) {
            observedFirstGraceCheck = true
            releaseFirstGraceCheck()
          }
          return stillCurrent ? 'keep-waiting' : 'abandoned'
        },
      }
      if (request === './errorUtils') return { simplifyError: (error: string) => error }
      if (request === './quietGuard') return { isSuspectQuietCapture: () => false }
      if (request === './remoteDispatchQueue') return originalLoad.call(this, request, parent, isMain)
      if (request.startsWith('./')) return moduleStub
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  let SessionManager!: typeof import('./sessionManager').SessionManager
  try {
    ;({ SessionManager } = await import('./sessionManager'))
  } finally {
    Module._load = originalLoad
  }

  const manager = new SessionManager()
  t.after(() => {
    if (manager.getCurrentSession()) manager.cancelSession()
  })
  const dictation = new ComposerDictationCoordinator()
  manager.onSessionEnded = identity => {
    if (identity?.composerDictationToken) dictation.abandon(identity.composerDictationToken)
  }
  manager.onComposerDictationQueued = token => { dictation.markQueued(token) }

  const captureA = dictation.begin('task-a', undefined, 'token-a')
  manager.startRemoteCapture('task-a', false, captureA)
  const processA = manager.processSession()
  await firstGraceCheck

  manager.cancelSession()
  const captureB = dictation.begin('task-b', undefined, 'token-b')
  manager.startRemoteCapture('task-b', false, captureB)
  const sessionB = manager.getCurrentSession()!
  const processB = manager.processSession()
  assert.equal(manager.processing, true, 'B owns the processing lock before A resumes')

  await processA
  assert.equal(manager.getCurrentSession(), sessionB)
  assert.equal(manager.processing, true, 'A cannot clear B\'s processing lock')
  assert.equal(dictation.activeDelivery?.token, 'token-b')
  assert.deepEqual(dispatched, [])

  manager.cancelSession()
  await processB
})
