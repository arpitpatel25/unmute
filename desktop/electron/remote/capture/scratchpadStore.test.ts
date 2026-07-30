import { test, describe } from 'node:test'
import assert from 'node:assert'
import { serialize, deserialize, shouldSettle, SETTLE_IDLE_MS } from './scratchpadStore'
import { emptyPad, addSegment, addInsert } from './captureBuffer'

function full() {
  let p = emptyPad('p1', 'task', 1000)
  p = addSegment(p, { id: 's1', text: 'hello', startMs: 0, endMs: 5 })
  p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://a.com', atMs: 6 })
  return p
}

describe('round trip', () => {
  test('a pad survives serialize then deserialize intact', () => {
    const p = full()
    assert.deepEqual(deserialize(serialize(p)), p)
  })
  test('an empty pad round-trips', () => {
    const p = emptyPad('p', 'cursor', 5)
    assert.deepEqual(deserialize(serialize(p)), p)
  })
})

describe('deserialize refuses anything it does not recognise', () => {
  test('malformed json returns null rather than throwing', () => {
    assert.equal(deserialize('{not json'), null)
  })
  test('json of the wrong shape returns null', () => {
    assert.equal(deserialize('{"a":1}'), null)
  })
  test('a null entries array returns null', () => {
    assert.equal(deserialize('{"id":"a","origin":"task","createdAt":0,"updatedAt":0,"entries":null}'), null)
  })
  test('an unknown origin returns null', () => {
    assert.equal(deserialize('{"id":"a","origin":"mars","createdAt":0,"updatedAt":0,"entries":[]}'), null)
  })

  // Beyond the brief: deserialize must never throw for ANY input string,
  // including JSON primitives and structurally-valid-but-wrong-shaped JSON.
  test('the empty string returns null rather than throwing', () => {
    assert.doesNotThrow(() => deserialize(''))
    assert.equal(deserialize(''), null)
  })
  test('the JSON literal null returns null rather than throwing', () => {
    assert.doesNotThrow(() => deserialize('null'))
    assert.equal(deserialize('null'), null)
  })
  test('a bare JSON string primitive returns null', () => {
    assert.doesNotThrow(() => deserialize('"5"'))
    assert.equal(deserialize('"5"'), null)
  })
  test('a bare JSON boolean primitive returns null', () => {
    assert.doesNotThrow(() => deserialize('true'))
    assert.equal(deserialize('true'), null)
  })
  test('a bare JSON number primitive returns null', () => {
    assert.doesNotThrow(() => deserialize('5'))
    assert.equal(deserialize('5'), null)
  })
  test('a bare JSON array returns null', () => {
    assert.doesNotThrow(() => deserialize('[]'))
    assert.equal(deserialize('[]'), null)
  })
  test('a deeply nested unrelated object returns null', () => {
    const raw = JSON.stringify({ a: { b: { c: { d: [1, 2, { e: 'f' }] } } } })
    assert.doesNotThrow(() => deserialize(raw))
    assert.equal(deserialize(raw), null)
  })
  test('a non-string id returns null', () => {
    assert.equal(
      deserialize('{"id":5,"origin":"task","createdAt":0,"updatedAt":0,"entries":[]}'),
      null,
    )
  })
  test('non-numeric createdAt/updatedAt returns null', () => {
    assert.equal(
      deserialize('{"id":"a","origin":"task","createdAt":"0","updatedAt":0,"entries":[]}'),
      null,
    )
    assert.equal(
      deserialize('{"id":"a","origin":"task","createdAt":0,"updatedAt":"0","entries":[]}'),
      null,
    )
  })
  test('an entry with an unknown type returns null', () => {
    const raw = JSON.stringify({
      id: 'a',
      origin: 'task',
      createdAt: 0,
      updatedAt: 0,
      entries: [{ type: 'mystery', id: 'x' }],
    })
    assert.equal(deserialize(raw), null)
  })
  test('an entry with a non-string id returns null', () => {
    const raw = JSON.stringify({
      id: 'a',
      origin: 'task',
      createdAt: 0,
      updatedAt: 0,
      entries: [{ type: 'segment', id: 5, text: '', startMs: 0, endMs: 0 }],
    })
    assert.equal(deserialize(raw), null)
  })
  test('a null entry inside entries returns null', () => {
    const raw = '{"id":"a","origin":"task","createdAt":0,"updatedAt":0,"entries":[null]}'
    assert.doesNotThrow(() => deserialize(raw))
    assert.equal(deserialize(raw), null)
  })
})

describe('settle', () => {
  test('a pad touched recently does not settle', () => {
    const p = { ...full(), updatedAt: 1000 }
    assert.equal(shouldSettle(p, 1000 + SETTLE_IDLE_MS - 1), false)
  })
  test('a pad idle past the threshold settles', () => {
    const p = { ...full(), updatedAt: 1000 }
    assert.equal(shouldSettle(p, 1000 + SETTLE_IDLE_MS + 1), true)
  })
  test('an EMPTY pad never settles — there is nothing to keep', () => {
    const p = { ...emptyPad('p', 'task', 0), updatedAt: 0 }
    assert.equal(shouldSettle(p, SETTLE_IDLE_MS * 10), false)
  })
})
