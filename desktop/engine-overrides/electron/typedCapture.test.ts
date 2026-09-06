import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

test('typed capture bypasses audio, preserves destination, and rejects stale/double submissions', async () => {
  const require = createRequire(import.meta.url)
  const Module = require('node:module')
  const load = Module._load
  const events: unknown[][] = []
  const deliveries: unknown[][] = []
  const noop = () => undefined
  let serial = 0
  Module._load = function(request: string, parent: { filename?: string }, ...rest: unknown[]) {
    if (parent?.filename?.endsWith('/engine-overrides/electron/sessionManager.ts')) {
      if (request === 'uuid') return { v4: () => `typed-${++serial}` }
      if (request === 'electron') return { app: { getPath: () => '/tmp', getVersion: () => 'test' } }
      if (request === './windowManager') return { showHUD: noop, hideHUD: noop, cancelPendingHide: noop, getWidgetWindow: () => ({ webContents: { send: (...args: unknown[]) => events.push(args) } }) }
      if (request === './dictationTelemetry') return { DEV_BUILD: false, initTelemetry: noop, logTelemetry: noop }
      if (request === './paywall/remote/init') return { dispatchFromCapture: async (...args: unknown[]) => deliveries.push(args), hideNativePill: noop, recordCapturedDictation: noop }
      if (request === './sttArbiter') return { SttArbiter: class { dispose() {} } }
      if (request === './featureFlags') return { features: { localModels: false } }
      if (request.startsWith('./')) return new Proxy({}, { get: () => noop })
    }
    return load.call(this, request, parent, ...rest)
  }
  let manager: any
  try { const { SessionManager } = await import('./sessionManager'); manager = new SessionManager() }
  finally { Module._load = load }
  manager.startRemoteCapture('original-task', false, undefined, true)
  const id = manager.getCurrentSession().sessionId
  // Even callers carrying the old remembered preference must start with voice.
  assert.equal(manager.getCurrentSession().typedInput, false)
  assert.equal(events.some(e => e[0] === 'recording:start'), true)
  await manager.prepareTypedCapture('original-task')
  assert.equal(manager.getCurrentSession().typedInput, true)
  manager.receiveAudio(Buffer.from('late microphone data'), 10, 'dictation', id)
  manager.receiveAudioChunk(Buffer.from('late chunk'), 0, 'dictation', id)
  assert.equal(manager.getCurrentSession().dictationAudio, null)
  await manager.processSession()
  assert.equal(deliveries.length, 0)
  assert.equal(await manager.submitTypedCapture('wrong', 'discard'), false)
  assert.equal(await manager.submitTypedCapture(id, 'Keep my exact words.'), true)
  assert.equal(await manager.submitTypedCapture(id, 'duplicate'), false)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0][0], 'Keep my exact words.')
  assert.equal(deliveries[0][2], 'original-task')
  manager.startRemoteCapture(null, true, undefined, true)
  await manager.prepareTypedCapture(null)
  const agentId = manager.getCurrentSession().sessionId
  manager.getCurrentSession().selectedText = 'Captured selection'
  await manager.submitTypedCapture(agentId, 'Explain this')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(deliveries[1][0], '> Captured selection\n\nExplain this')
  assert.deepEqual(deliveries[1][3], { route: 'agent', typedInput: true })
  manager.startRemoteCapture('cancelled-task', false, undefined, true)
  await manager.prepareTypedCapture('cancelled-task')
  const cancelledId = manager.getCurrentSession().sessionId
  manager.cancelSession()
  assert.equal(await manager.submitTypedCapture(cancelledId, 'must not send'), false)
  assert.equal(deliveries.length, 2)
  manager.startRemoteCapture('voice-task')
  assert.equal(manager.getCurrentSession().typedInput, false)
  assert.equal(events.some(e => e[0] === 'recording:start'), true)
  await manager.prepareTypedCapture('voice-task')
  const voiceId = manager.getCurrentSession().sessionId
  events.length = 0
  assert.equal(manager.resumeVoiceCapture(voiceId), true)
  assert.equal(manager.getCurrentSession().typedInput, false)
  assert.equal(events.filter(e => e[0] === 'recording:start').length, 1)
  assert.equal(await manager.submitTypedCapture(voiceId, 'stale typed draft'), false)
  manager.cancelSession()
})
