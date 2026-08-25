import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { extractJson } from './extractJson'

describe('extractJson', () => {
  test('bare JSON array parses directly', () => {
    assert.deepEqual(extractJson('[1,2,3]', 'array'), [1, 2, 3])
  })

  test('bare JSON object parses directly', () => {
    assert.deepEqual(extractJson('{"a":1}', 'object'), { a: 1 })
  })

  test('a ```json fenced array is extracted — the real, live-observed Claude Code shape', () => {
    const raw = '```json\n[{"id":0,"text":"Thank you."},{"id":1,"text":"Hello."}]\n```'
    assert.deepEqual(extractJson(raw, 'array'), [{ id: 0, text: 'Thank you.' }, { id: 1, text: 'Hello.' }])
  })

  test('a fenced object with no language tag is extracted', () => {
    const raw = '```\n{"title":"T","summary":"S"}\n```'
    assert.deepEqual(extractJson(raw, 'object'), { title: 'T', summary: 'S' })
  })

  test('prose before and after a fenced block is ignored', () => {
    const raw = 'Here is the corrected transcript:\n\n```json\n[{"id":0,"text":"hi"}]\n```\n\nLet me know if you need anything else!'
    assert.deepEqual(extractJson(raw, 'array'), [{ id: 0, text: 'hi' }])
  })

  test('prose-wrapped JSON with no fence at all falls back to a bracket scan', () => {
    const raw = 'Sure, here you go: [{"id":0,"text":"hi"}] — hope that helps.'
    assert.deepEqual(extractJson(raw, 'array'), [{ id: 0, text: 'hi' }])
  })

  test('object bracket scan does not get confused by array brackets in surrounding prose', () => {
    const raw = 'Your keyPoints list has [3] items. {"title":"T","summary":"S"}'
    assert.deepEqual(extractJson(raw, 'object'), { title: 'T', summary: 'S' })
  })

  test('completely unparseable text returns undefined, never throws', () => {
    assert.equal(extractJson('not json at all, no brackets either', 'array'), undefined)
  })

  test('a fence containing invalid JSON falls through to the bracket scan instead of failing outright', () => {
    const raw = '```json\n{not valid json}\n```\nbut actually [{"id":0,"text":"hi"}] is here'
    assert.deepEqual(extractJson(raw, 'array'), [{ id: 0, text: 'hi' }])
  })
})
