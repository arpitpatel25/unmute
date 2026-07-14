import { test, describe } from 'node:test'
import assert from 'node:assert'
import { SttArbiter } from './sttArbiter'

// Manually-resolvable promise helper
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const tick = () => new Promise((r) => setImmediate(r))
// Fast timeouts so tests run in ms
const FAST = { speculateAfterMs: 10, offerAfterMs: 40, hardDeadlineMs: 100, lateCloudWindowMs: 200 }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('SttArbiter', () => {
  test('cloud resolving mid-recording commits cloud immediately', async () => {
    const a = new SttArbiter({}, FAST)
    const cloud = deferred<string | null>()
    const p = a.submitChunk(0, cloud.promise, () => Promise.resolve('draft'))
    cloud.resolve('hello from cloud')
    assert.deepEqual(await p, { text: 'hello from cloud', source: 'cloud' })
    a.dispose()
  })

  test('mid-recording chunk with slow cloud does NOT commit local — waits', async () => {
    const a = new SttArbiter({}, FAST)
    const cloud = deferred<string | null>()
    let resolved = false
    const p = a.submitChunk(0, cloud.promise, () => Promise.resolve('draft'))
    void p.then(() => { resolved = true })
    await wait(150) // way past hardDeadlineMs — but recording never ended
    assert.equal(resolved, false)
    cloud.resolve('late cloud')
    assert.deepEqual(await p, { text: 'late cloud', source: 'cloud' })
    a.dispose()
  })

  test('hard deadline after recordingEnded commits local drafts', async () => {
    const events: string[] = []
    const a = new SttArbiter({ onDraftResolved: (how) => events.push(how) }, FAST)
    const cloud = deferred<string | null>()
    const p = a.submitChunk(0, cloud.promise, () => Promise.resolve('local draft'))
    a.recordingEnded()
    const r = await p
    assert.deepEqual(r, { text: 'local draft', source: 'local' })
    assert.deepEqual(events, ['deadline'])
    a.dispose()
  })

  test('offer fires at offerAfterMs; all-cloud completion dismisses it', async () => {
    let offered = 0
    const resolved: string[] = []
    const a = new SttArbiter({ onDraftOffer: () => { offered++ }, onDraftResolved: (h) => resolved.push(h) }, FAST)
    const cloud = deferred<string | null>()
    const p = a.submitChunk(0, cloud.promise, () => Promise.resolve('draft'))
    a.recordingEnded()
    await wait(60) // past offerAfterMs, before hardDeadlineMs
    assert.equal(offered, 1)
    cloud.resolve('cloud text')
    assert.deepEqual(await p, { text: 'cloud text', source: 'cloud' })
    assert.deepEqual(resolved, ['cloud'])
    a.dispose()
  })

  test('acceptDraft switches immediately', async () => {
    const resolved: string[] = []
    const a = new SttArbiter({ onDraftResolved: (h) => resolved.push(h) }, FAST)
    const cloud = deferred<string | null>()
    const p = a.submitChunk(0, cloud.promise, () => Promise.resolve('quick draft'))
    a.recordingEnded()
    await wait(20) // let speculation start + draft resolve
    a.acceptDraft()
    assert.deepEqual(await p, { text: 'quick draft', source: 'local' })
    assert.deepEqual(resolved, ['accepted'])
    a.dispose()
  })

  test('one-way ordered switch: later chunk with resolved cloud still goes local after switch', async () => {
    const a = new SttArbiter({}, FAST)
    const cloud0 = deferred<string | null>()
    const cloud1 = deferred<string | null>()
    const p0 = a.submitChunk(0, cloud0.promise, () => Promise.resolve('local0'))
    const p1 = a.submitChunk(1, cloud1.promise, () => Promise.resolve('local1'))
    cloud1.resolve('cloud1') // chunk 1's cloud is fast; chunk 0's never comes
    await tick()
    a.recordingEnded()
    const [r0, r1] = await Promise.all([p0, p1])
    // switch happened at index 0 → BOTH local: shape is full-local, never local-sandwich
    assert.deepEqual(r0, { text: 'local0', source: 'local' })
    assert.deepEqual(r1, { text: 'local1', source: 'local' })
    assert.equal(a.engineSummary, 'local')
    a.dispose()
  })

  test('cloud prefix survives: chunks committed cloud BEFORE the switch stay cloud', async () => {
    const a = new SttArbiter({}, FAST)
    const cloud0 = deferred<string | null>()
    const cloud1 = deferred<string | null>()
    const p0 = a.submitChunk(0, cloud0.promise, () => Promise.resolve('local0'))
    cloud0.resolve('cloud0')
    assert.deepEqual(await p0, { text: 'cloud0', source: 'cloud' })
    const p1 = a.submitChunk(1, cloud1.promise, () => Promise.resolve('local1'))
    a.recordingEnded()
    const r1 = await p1
    assert.deepEqual(r1, { text: 'local1', source: 'local' })
    assert.equal(a.engineSummary, 'mixed')
    a.dispose()
  })

  test('switched chunk with no local falls back to awaiting cloud', async () => {
    const a = new SttArbiter({}, FAST)
    const cloud = deferred<string | null>()
    const p = a.submitChunk(0, cloud.promise, null) // local unavailable
    a.recordingEnded()
    await wait(120) // past hard deadline — switch wanted, no draft
    cloud.resolve('only text there is')
    assert.deepEqual(await p, { text: 'only text there is', source: 'cloud' })
    a.dispose()
  })

  test('both null resolves null', async () => {
    const a = new SttArbiter({}, FAST)
    const p = a.submitChunk(0, Promise.resolve(null), () => Promise.resolve(null))
    a.recordingEnded()
    assert.equal(await p, null)
    a.dispose()
  })

  test('late cloud after local commit fires onLateCloud within the window', async () => {
    const late: Array<[number, string]> = []
    const a = new SttArbiter({ onLateCloud: (i, t) => late.push([i, t]) }, FAST)
    const cloud = deferred<string | null>()
    const p = a.submitChunk(0, cloud.promise, () => Promise.resolve('draft'))
    a.recordingEnded()
    await p // committed local via deadline
    cloud.resolve('better take')
    await tick()
    assert.deepEqual(late, [[0, 'better take']])
    a.dispose()
  })

  test('cloud failure mid-recording triggers the one-way switch — no local→cloud sandwich', async () => {
    const a = new SttArbiter({}, FAST)
    const cloud1 = deferred<string | null>()
    const p0 = a.submitChunk(0, Promise.resolve(null), () => Promise.resolve('local0')) // cloud fails
    const p1 = a.submitChunk(1, cloud1.promise, () => Promise.resolve('local1'))
    await tick()
    cloud1.resolve('cloud1') // arrives AFTER the failure-triggered switch — must be ignored
    const [r0, r1] = await Promise.all([p0, p1])
    assert.deepEqual(r0, { text: 'local0', source: 'local' })
    assert.deepEqual(r1, { text: 'local1', source: 'local' })
    assert.equal(a.engineSummary, 'local')
    a.dispose()
  })

  test('chunk submitted after the deadline already fired still gets deadline coverage — never hangs', async () => {
    const a = new SttArbiter({}, FAST)
    const cloud0 = deferred<string | null>()
    const p0 = a.submitChunk(0, cloud0.promise, () => Promise.resolve('local0'))
    cloud0.resolve('cloud0')
    assert.deepEqual(await p0, { text: 'cloud0', source: 'cloud' })
    a.recordingEnded()
    await wait(120) // past hardDeadlineMs — session timers fired/self-disarmed with nothing pending
    const neverCloud = new Promise<string | null>(() => {})
    const p1 = a.submitChunk(1, neverCloud, () => Promise.resolve('local1'))
    const r1 = await p1 // must resolve via a freshly-armed deadline, not hang
    assert.deepEqual(r1, { text: 'local1', source: 'local' })
    assert.equal(a.engineSummary, 'mixed')
    a.dispose()
  })

  test('dispose settles uncommitted chunks with null and suppresses all later events', async () => {
    const events: string[] = []
    const late: Array<[number, string]> = []
    const a = new SttArbiter({
      onDraftOffer: () => events.push('offer'),
      onDraftResolved: (h) => events.push(h),
      onLateCloud: (i, t) => late.push([i, t]),
    }, FAST)
    const cloud = deferred<string | null>()
    const p = a.submitChunk(0, cloud.promise, () => Promise.resolve('draft'))
    a.recordingEnded()
    a.dispose()
    assert.equal(await p, null) // settled immediately, no hang
    cloud.resolve('too late')
    await wait(120) // past offer + deadline — nothing may fire post-dispose
    assert.deepEqual(events, [])
    assert.deepEqual(late, [])
  })

  test('acceptDraft before recordingEnded is a no-op', async () => {
    const resolved: string[] = []
    const a = new SttArbiter({ onDraftResolved: (h) => resolved.push(h) }, FAST)
    const cloud = deferred<string | null>()
    const p = a.submitChunk(0, cloud.promise, () => Promise.resolve('draft'))
    a.acceptDraft() // mid-recording: ignored
    await wait(20)
    assert.deepEqual(resolved, [])
    cloud.resolve('cloud text')
    assert.deepEqual(await p, { text: 'cloud text', source: 'cloud' })
    a.dispose()
  })
})
