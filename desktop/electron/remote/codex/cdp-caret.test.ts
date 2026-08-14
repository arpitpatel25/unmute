// Focusing the composer with a click at its CENTRE leaves the caret wherever
// the click landed. Measured against the live app: a composer holding
// "AAAA\nBBBB\nCCCC\nDDDD" took a centre click and an insert, and the text
// arrived as "AAAA\nBBBB\nCCCC<<INSERTED>>\nDDDD" — the message spliced into
// the middle of existing content. Focus must end with the caret after
// everything already there.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexCdp, COLLAPSE_TO_END_JS } from './cdp'

test('the focus collapse puts the caret after all existing composer content', () => {
  const calls: Array<{ method: string; arg?: unknown }> = []
  const range = {
    selectNodeContents: (node: unknown) => calls.push({ method: 'selectNodeContents', arg: node }),
    collapse: (toStart: boolean) => calls.push({ method: 'collapse', arg: toStart }),
  }
  const composer = { tagName: 'DIV' }
  const document = {
    querySelector: () => composer,
    createRange: () => range,
  }
  const getSelection = () => ({
    removeAllRanges: () => calls.push({ method: 'removeAllRanges' }),
    addRange: (r: unknown) => calls.push({ method: 'addRange', arg: r === range }),
  })

  new Function('document', 'getSelection', `return ${COLLAPSE_TO_END_JS}`)(document, getSelection)

  assert.deepEqual(calls, [
    { method: 'selectNodeContents', arg: composer },
    { method: 'collapse', arg: false },
    { method: 'removeAllRanges' },
    { method: 'addRange', arg: true },
  ])
})

test('focusComposer collapses the caret to the end after its trusted click', async () => {
  const order: string[] = []
  const cdp = Object.create(CodexCdp.prototype) as any
  cdp.evaluate = async (expression: string) => {
    if (expression === COLLAPSE_TO_END_JS) { order.push('collapse'); return null }
    order.push('locate')
    return JSON.stringify({ x: 10, y: 20 })
  }
  cdp.click = async () => { order.push('click') }

  assert.equal(await cdp.focusComposer(), true)
  assert.deepEqual(order, ['locate', 'click', 'collapse'])
})

test('focusComposer reports failure and never collapses when no composer is mounted', async () => {
  const order: string[] = []
  const cdp = Object.create(CodexCdp.prototype) as any
  cdp.evaluate = async (expression: string) => {
    if (expression === COLLAPSE_TO_END_JS) { order.push('collapse'); return null }
    return ''
  }
  cdp.click = async () => { order.push('click') }

  assert.equal(await cdp.focusComposer(), false)
  assert.deepEqual(order, [])
})
