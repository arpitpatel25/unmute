import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import { WebSocketServer } from 'ws'
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
  // Distinct ws urls per target so the assertion can actually tell which
  // target got connected to (previously both fakes shared 'ws://x', making
  // this test unable to distinguish same-vs-different target).
  const targets = [
    target({ id: 'A1', title: 'Calorify AI', webSocketDebuggerUrl: 'ws://page-a1' }),
    target({ id: 'B2', title: 'Tab Bar', webSocketDebuggerUrl: 'ws://tab-bar-b2' }),
  ]
  const seenUrls: string[] = []
  const tr: CdpTransport = {
    async listTargets() { return targets },
    async connect(url) { seenUrls.push(url); return { async send() { return { result: { result: { value: 1 } } } }, close() {} } },
  }
  const lane = new CdpLane(() => 9222, tr)
  await lane.eval('Notion', '1'); await lane.eval('Notion', '2')
  // Both calls target the SAME (non-"Tab Bar") page — never the Tab Bar one.
  assert.equal(seenUrls.length, 2)
  assert.equal(seenUrls[0], 'ws://page-a1')
  assert.equal(seenUrls[1], 'ws://page-a1')
  assert.notEqual(seenUrls[0], 'ws://tab-bar-b2')
})

test('eval rejects when Runtime.evaluate reply carries exceptionDetails', async () => {
  const lane = new CdpLane(() => 9222, fakeTransport([target()], () => ({
    result: {
      result: { type: 'undefined' },
      exceptionDetails: { exception: { description: 'ReferenceError: x is not defined' } },
    },
  })))
  await assert.rejects(() => lane.eval('Notion', 'x'), /ReferenceError: x is not defined/)
})

test('send() resolves with the full JSON-RPC message (regression: no double-unwrap)', async () => {
  // Guards the exact bug from the review: defaultTransport's message handler
  // used to resolve send() with `msg.result` while every consumer reads
  // `res.result.result.value` / `res.result.data` / `res.result.exceptionDetails`
  // off the return value. Dispatch a realistic CDP envelope straight at a
  // fake matching defaultTransport's wire contract (full msg, not msg.result)
  // and confirm eval() unwraps it to the primitive value.
  const lane = new CdpLane(() => 9222, fakeTransport([target()], () => ({
    id: 1,
    result: { result: { type: 'number', value: 42 } },
  })))
  const v = await lane.eval('Notion', '1+41')
  assert.equal(v, 42)
})

test('defaultTransport end-to-end: real ws server round-trips Runtime.evaluate', async () => {
  // Stands up a tiny in-process ws server that speaks a realistic CDP reply
  // shape, and points CdpLane's OWN default transport (no fake) at it. This
  // exercises defaultTransport's real message parsing/dispatch, which is
  // exactly where the double-unwrap bug lived.
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const port = (wss.address() as { port: number }).port
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.method === 'Runtime.evaluate') {
        socket.send(JSON.stringify({ id: msg.id, result: { result: { type: 'number', value: 42 } } }))
      }
    })
  })
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/json') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify([target({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/A1` })]))
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const httpPort = (httpServer.address() as { port: number }).port

  try {
    // No transport arg → uses defaultTransport (the real ws client under test).
    const lane = new CdpLane(() => httpPort)
    const v = await lane.eval('Notion', '1+41')
    assert.equal(v, 42)
  } finally {
    httpServer.close()
    wss.close()
  }
})

test('click dispatches mousePressed then mouseReleased at x,y', async () => {
  const calls: any[] = []
  const lane = new CdpLane(() => 9222, fakeTransport([target()], (m, p) => { calls.push([m, p]); return {} }))
  const r = await lane.click('Notion', 10, 20)
  assert.deepEqual(r, { clicked: { x: 10, y: 20 } })
  const mouseEvents = calls.filter((c) => c[0] === 'Input.dispatchMouseEvent')
  assert.equal(mouseEvents.length, 2)
  assert.equal(mouseEvents[0][1].type, 'mousePressed'); assert.equal(mouseEvents[0][1].x, 10); assert.equal(mouseEvents[0][1].y, 20)
  assert.equal(mouseEvents[1][1].type, 'mouseReleased'); assert.equal(mouseEvents[1][1].x, 10); assert.equal(mouseEvents[1][1].y, 20)
})

test('key(Enter) dispatches Input.dispatchKeyEvent with key:Enter', async () => {
  const calls: any[] = []
  const lane = new CdpLane(() => 9222, fakeTransport([target()], (m, p) => { calls.push([m, p]); return {} }))
  await lane.key('Notion', 'Enter')
  const keyEvents = calls.filter((c) => c[0] === 'Input.dispatchKeyEvent')
  assert.equal(keyEvents.length, 2)
  assert.equal(keyEvents[0][1].key, 'Enter')
  assert.equal(keyEvents[0][1].type, 'keyDown')
})

test('key(v, [cmd]) dispatches with modifiers bitmask 4', async () => {
  const calls: any[] = []
  const lane = new CdpLane(() => 9222, fakeTransport([target()], (m, p) => { calls.push([m, p]); return {} }))
  await lane.key('Notion', 'v', ['cmd'])
  const keyEvents = calls.filter((c) => c[0] === 'Input.dispatchKeyEvent')
  assert.equal(keyEvents[0][1].modifiers, 4)
  assert.equal(keyEvents[1][1].modifiers, 4)
})

test('scroll(-300) dispatches a mouseWheel event with deltaY:-300', async () => {
  const calls: any[] = []
  const lane = new CdpLane(() => 9222, fakeTransport([target()], (m, p) => { calls.push([m, p]); return {} }))
  const r = await lane.scroll('Notion', -300)
  assert.deepEqual(r, { deltaY: -300, deltaX: 0 })
  assert.equal(calls[0][0], 'Input.dispatchMouseEvent')
  assert.equal(calls[0][1].type, 'mouseWheel')
  assert.equal(calls[0][1].deltaY, -300)
})

test('drag(1,2,3,4) presses at (1,2) and releases at (3,4)', async () => {
  const calls: any[] = []
  const lane = new CdpLane(() => 9222, fakeTransport([target()], (m, p) => { calls.push([m, p]); return {} }))
  const r = await lane.drag('Notion', 1, 2, 3, 4)
  assert.deepEqual(r, { from: { x1: 1, y1: 2 }, to: { x2: 3, y2: 4 } })
  const mouseEvents = calls.filter((c) => c[0] === 'Input.dispatchMouseEvent')
  const pressed = mouseEvents.find((c) => c[1].type === 'mousePressed')
  const released = mouseEvents.find((c) => c[1].type === 'mouseReleased')
  assert.equal(pressed[1].x, 1); assert.equal(pressed[1].y, 2)
  assert.equal(released[1].x, 3); assert.equal(released[1].y, 4)
})

test('navigate sends Page.navigate with the given url', async () => {
  const calls: any[] = []
  const lane = new CdpLane(() => 9222, fakeTransport([target()], (m, p) => { calls.push([m, p]); return {} }))
  const r = await lane.navigate('Notion', 'https://x')
  assert.deepEqual(r, { navigated: 'https://x' })
  const navCall = calls.find((c) => c[0] === 'Page.navigate')
  assert.equal(navCall[1].url, 'https://x')
})

test('waitFor resolves when the polled eval returns truthy', async () => {
  const lane = new CdpLane(() => 9222, fakeTransport([target()], () => ({ result: { result: { value: true } } })))
  const r = await lane.waitFor('Notion', 'true', 1000)
  assert.deepEqual(r, { ok: true })
})

test('waitFor throws after the timeout when eval never returns truthy', async () => {
  const lane = new CdpLane(() => 9222, fakeTransport([target()], () => ({ result: { result: { value: false } } })))
  await assert.rejects(() => lane.waitFor('Notion', 'false', 250), /waitFor timed out after 250ms/)
})

test('targets returns page targets as {id,title,url}', async () => {
  const targets = [
    target({ id: 'A1', title: 'Calorify AI', url: 'https://a', type: 'page' }),
    target({ id: 'B2', title: 'Tab Bar', url: 'https://b', type: 'other' }),
  ]
  const lane = new CdpLane(() => 9222, fakeTransport(targets, () => ({})))
  const r = await lane.targets('Notion')
  assert.deepEqual(r, [{ id: 'A1', title: 'Calorify AI', url: 'https://a' }])
})

test('targets throws when the app is not armed', async () => {
  const lane = new CdpLane(() => undefined, fakeTransport([target()], () => ({})))
  await assert.rejects(() => lane.targets('Notion'), /not armed/)
})

test('pending send() rejects (does not hang) when the socket closes mid-flight', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const port = (wss.address() as { port: number }).port
  wss.on('connection', (socket) => {
    // Never reply — instead close the socket right after the client's
    // request lands, simulating the app/renderer going away mid-call.
    socket.on('message', () => { socket.close() })
  })
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/json') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify([target({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/A1` })]))
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const httpPort = (httpServer.address() as { port: number }).port

  try {
    const lane = new CdpLane(() => httpPort)
    await assert.rejects(() => lane.eval('Notion', '1+41'), /closed/)
  } finally {
    httpServer.close()
    wss.close()
  }
})
