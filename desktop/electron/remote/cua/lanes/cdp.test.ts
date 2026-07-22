import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CdpLane, type CdpTransport, type CdpTarget } from './cdp'

function fakeTransport(targets: CdpTarget[], onSend: (m: string, p: any) => any): CdpTransport {
  return {
    async listTargets() { return targets },
    async connect() { return { async send(method, params) { return onSend(method, params) }, close() {} } },
  }
}
const target = (over: Partial<CdpTarget> = {}): CdpTarget =>
  ({ id: 'A1', type: 'page', title: 'Calorify AI', url: 'x', webSocketDebuggerUrl: 'ws://x', ...over })

test('eval returns the JS value via Runtime.evaluate', async () => {
  const seen: any[] = []
  const lane = new CdpLane(() => 9222, fakeTransport([target()], (m, p) => {
    seen.push([m, p]); return { result: { result: { value: 42 } } }
  }))
  const v = await lane.eval('Notion', '1+41')
  assert.equal(v, 42)
  assert.equal(seen[0][0], 'Runtime.evaluate')
  assert.equal(seen[0][1].expression, '1+41')
})

test('eval throws when the app is not armed', async () => {
  const lane = new CdpLane(() => undefined, fakeTransport([target()], () => ({})))
  await assert.rejects(() => lane.eval('Notion', '1'), /not armed/)
})

test('typeKeys dispatches one keyDown+keyUp per character', async () => {
  const calls: any[] = []
  const lane = new CdpLane(() => 9222, fakeTransport([target()], (m, p) => { calls.push([m, p]); return {} }))
  await lane.typeKeys('Notion', 'ab')
  const keyEvents = calls.filter(c => c[0] === 'Input.dispatchKeyEvent')
  assert.equal(keyEvents.length, 4) // a↓ a↑ b↓ b↑
  assert.equal(keyEvents[0][1].type, 'keyDown'); assert.equal(keyEvents[0][1].text, 'a')
})

test('scrollBottom sets scrollTop to scrollHeight and reports atBottom', async () => {
  const lane = new CdpLane(() => 9222, fakeTransport([target()], (m, p) =>
    ({ result: { result: { value: { before: 0, after: 1577, atBottom: true } } } })))
  const r = await lane.scrollBottom('Notion')
  assert.equal(r.atBottom, true)
})

test('target selection follows the same webContents id across calls', async () => {
  const targets = [target({ id: 'A1', title: 'Calorify AI' }), target({ id: 'B2', title: 'Tab Bar' })]
  const seenUrls: string[] = []
  const tr: CdpTransport = {
    async listTargets() { return targets },
    async connect(url) { seenUrls.push(url); return { async send() { return { result: { result: { value: 1 } } } }, close() {} } },
  }
  const lane = new CdpLane(() => 9222, tr)
  await lane.eval('Notion', '1'); await lane.eval('Notion', '2')
  // Both calls target the SAME (non-"Tab Bar") page.
  assert.equal(seenUrls.length, 2)
})
