import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { PillController, type PillStateP } from './pill-controller'

function harness() {
  const sent: Array<{ type: string; [k: string]: unknown }> = []
  let handler: (e: { type: string; [k: string]: unknown }) => void = () => {}
  const calls: string[] = []
  const client = {
    send: (c: { type: string; [k: string]: unknown }) => { sent.push(c) },
    on: (_e: string, cb: (e: { type: string; [k: string]: unknown }) => void) => { handler = cb },
  }
  const deps = {
    stop: () => calls.push('stop'),
    cancel: () => calls.push('cancel'),
    undo: () => calls.push('undo'),
    acceptDraft: () => calls.push('acceptDraft'),
    pickModel: (id: string) => calls.push(`pickModel:${id}`),
    pickAgent: (id: string) => calls.push(`pickAgent:${id}`),
    cycleAgent: () => calls.push('cycleAgent'),
    pickAxis: (axis: string, value: string) => calls.push(`pickAxis:${axis}=${value}`),
    pickMic: (id: string) => calls.push(`pickMic:${id}`),
    toggleRaw: (on: boolean) => calls.push(`toggleRaw:${on}`),
    clearStaged: () => calls.push('clearStaged'),
    openBillingPortal: () => calls.push('openBillingPortal'),
    dismissOffline: () => calls.push('dismissOffline'),
  }
  const c = new PillController(client, deps)
  const state = () => sent[sent.length - 1]?.state as PillStateP | undefined
  return { c, sent, calls, state, fire: (e: Record<string, unknown>) => handler(e as never) }
}

describe('PillController.push', () => {
  test('sends the merged state, not just the delta', () => {
    const h = harness()
    h.c.push({ phase: 'recording', kind: 'remote', model: 'Sonnet' })
    h.c.push({ elapsed: 3 })
    assert.deepEqual(h.state(), {
      phase: 'recording', kind: 'remote', model: 'Sonnet', elapsed: 3,
    })
  })

  test('drops an unchanged payload — a renderer that re-renders every tick cannot flood the helper', () => {
    const h = harness()
    h.c.push({ phase: 'recording', level: 0.5 })
    const n = h.sent.length
    h.c.push({ phase: 'recording', level: 0.5 })
    h.c.push({ level: 0.5 })
    assert.equal(h.sent.length, n)
  })

  test('a changed nested option list is not treated as unchanged', () => {
    const h = harness()
    h.c.push({ modelOptions: [{ id: 'a', label: 'A' }] })
    const n = h.sent.length
    h.c.push({ modelOptions: [{ id: 'b', label: 'B' }] })
    assert.equal(h.sent.length, n + 1)
  })
})

describe('PillController.level', () => {
  test('is a no-op unless a capture is running — no traffic on the audio path when idle', () => {
    const h = harness()
    h.c.push({ phase: 'hidden' })
    const n = h.sent.length
    h.c.level(0.8)
    assert.equal(h.sent.length, n)
  })

  test('sends while listening, and carries elapsed when given', () => {
    const h = harness()
    h.c.push({ phase: 'recording' })
    h.c.level(0.8, 4)
    assert.equal(h.state()?.level, 0.8)
    assert.equal(h.state()?.elapsed, 4)
  })

  test('repeated identical levels still send — the meter must not stall on a plateau', () => {
    const h = harness()
    h.c.push({ phase: 'recording' })
    h.c.level(0.5)
    const n = h.sent.length
    h.c.level(0.5)
    assert.equal(h.sent.length, n + 1)
  })
})

describe('PillController events', () => {
  test('every gesture reaches its handler', () => {
    const h = harness()
    h.fire({ type: 'pillStop' })
    h.fire({ type: 'pillCancel' })
    h.fire({ type: 'pillUndo' })
    h.fire({ type: 'pillAcceptDraft' })
    h.fire({ type: 'pillPickModel', value: 'opus' })
    h.fire({ type: 'pillPickAgent', value: 'codex-desktop' })
    h.fire({ type: 'pillCycleAgent' })
    h.fire({ type: 'pillPickAxis', axis: 'Effort', value: 'High' })
    h.fire({ type: 'pillPickMic', value: 'iphone' })
    h.fire({ type: 'pillToggleRaw', value: true })
    h.fire({ type: 'pillClearStaged' })
    h.fire({ type: 'pillOpenBillingPortal' })
    h.fire({ type: 'pillDismissOffline' })
    assert.deepEqual(h.calls, [
      'stop', 'cancel', 'undo', 'acceptDraft',
      'pickModel:opus', 'pickAgent:codex-desktop', 'cycleAgent', 'pickAxis:Effort=High', 'pickMic:iphone',
      'toggleRaw:true', 'clearStaged', 'openBillingPortal', 'dismissOffline',
    ])
  })

  test('a notch event is ignored — the two surfaces share a channel but not a vocabulary', () => {
    const h = harness()
    h.fire({ type: 'next' })
    h.fire({ type: 'focusTask', id: 't1' })
    assert.deepEqual(h.calls, [])
  })

  test('a pick with no value is dropped rather than dispatched empty', () => {
    const h = harness()
    h.fire({ type: 'pillPickModel' })
    h.fire({ type: 'pillPickAgent', value: 3 })
    assert.deepEqual(h.calls, [])
  })

  test('an axis pick needs BOTH an axis and a value — a half-formed one is dropped', () => {
    const h = harness()
    h.fire({ type: 'pillPickAxis', value: 'High' })            // no axis
    h.fire({ type: 'pillPickAxis', axis: 'Effort' })           // no value
    h.fire({ type: 'pillPickAxis', axis: 7, value: 'High' })   // axis not a string
    assert.deepEqual(h.calls, [])
  })

  test('modelAxes and modelOptions are both carried — the platform gate lives upstream', () => {
    const h = harness()
    h.c.push({ agent: 'Codex', modelAxes: [{ axis: 'Effort', values: ['Low', 'High'], current: 'High' }] })
    assert.equal(h.state()?.modelAxes?.[0].axis, 'Effort')
    h.c.push({ agent: 'Claude Code', modelAxes: undefined, modelOptions: [{ id: 'opus', label: 'Opus' }] })
    assert.equal(h.state()?.modelOptions?.[0].id, 'opus')
  })

  test('toggleRaw only reads a real boolean true as on', () => {
    const h = harness()
    h.fire({ type: 'pillToggleRaw', value: 'true' })
    assert.deepEqual(h.calls, ['toggleRaw:false'])
  })
})

describe('PillController.hide', () => {
  test('clears prior state so a stale chip cannot survive into the next capture', () => {
    const h = harness()
    h.c.push({ phase: 'recording', stagedCount: 3, model: 'Opus' })
    h.c.hide()
    assert.deepEqual(h.state(), { phase: 'hidden' })
    h.c.push({ phase: 'recording' })
    assert.equal(h.state()?.stagedCount, undefined)
    assert.equal(h.state()?.model, undefined)
  })
})
