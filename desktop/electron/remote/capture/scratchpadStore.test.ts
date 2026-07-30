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

// A version-skewed or truncated pad must not survive load. insertRender does
// `e.text.trim()` on a segment, so a segment without `text` would throw AT
// DELIVERY and take the held work with it — the one failure this feature
// promises can't happen. Every payload field is checked here instead.
describe('deserialize validates entry PAYLOADS, not just the tag', () => {
  const wrap = (entry: unknown): string => JSON.stringify({
    id: 'a', origin: 'task', createdAt: 0, updatedAt: 0, entries: [entry],
  })

  describe('segment', () => {
    test('a well-formed segment is accepted', () => {
      const raw = wrap({ type: 'segment', id: 's', text: 'hi', startMs: 0, endMs: 1 })
      assert.deepEqual(deserialize(raw)?.entries.length, 1)
    })
    test('a segment with no text returns null', () => {
      assert.equal(deserialize(wrap({ type: 'segment', id: 's', startMs: 0, endMs: 1 })), null)
    })
    test('a segment whose text is not a string returns null', () => {
      assert.equal(
        deserialize(wrap({ type: 'segment', id: 's', text: 5, startMs: 0, endMs: 1 })),
        null,
      )
    })
    test('a segment whose text is null returns null', () => {
      assert.equal(
        deserialize(wrap({ type: 'segment', id: 's', text: null, startMs: 0, endMs: 1 })),
        null,
      )
    })
    test('a segment with a missing startMs returns null', () => {
      assert.equal(deserialize(wrap({ type: 'segment', id: 's', text: '', endMs: 1 })), null)
    })
    test('a segment with a non-numeric startMs returns null', () => {
      assert.equal(
        deserialize(wrap({ type: 'segment', id: 's', text: '', startMs: '0', endMs: 1 })),
        null,
      )
    })
    test('a segment with a missing endMs returns null', () => {
      assert.equal(deserialize(wrap({ type: 'segment', id: 's', text: '', startMs: 0 })), null)
    })
    test('a segment with a non-numeric endMs returns null', () => {
      assert.equal(
        deserialize(wrap({ type: 'segment', id: 's', text: '', startMs: 0, endMs: null })),
        null,
      )
    })
  })

  describe('insert', () => {
    test('a well-formed insert is accepted', () => {
      const raw = wrap({ type: 'insert', id: 'i', kind: 'image', content: '/a.png', atMs: 2 })
      assert.deepEqual(deserialize(raw)?.entries.length, 1)
    })
    test('an insert with an unknown kind returns null', () => {
      assert.equal(
        deserialize(wrap({ type: 'insert', id: 'i', kind: 'video', content: 'x', atMs: 0 })),
        null,
      )
    })
    test('an insert with no kind returns null', () => {
      assert.equal(deserialize(wrap({ type: 'insert', id: 'i', content: 'x', atMs: 0 })), null)
    })
    test('an insert with a non-string kind returns null', () => {
      assert.equal(
        deserialize(wrap({ type: 'insert', id: 'i', kind: 3, content: 'x', atMs: 0 })),
        null,
      )
    })
    test('an insert with no content returns null', () => {
      assert.equal(deserialize(wrap({ type: 'insert', id: 'i', kind: 'url', atMs: 0 })), null)
    })
    test('an insert whose content is not a string returns null', () => {
      assert.equal(
        deserialize(wrap({ type: 'insert', id: 'i', kind: 'url', content: { a: 1 }, atMs: 0 })),
        null,
      )
    })
    test('an insert with no atMs returns null', () => {
      assert.equal(deserialize(wrap({ type: 'insert', id: 'i', kind: 'url', content: 'x' })), null)
    })
    test('an insert with a non-numeric atMs returns null', () => {
      assert.equal(
        deserialize(wrap({ type: 'insert', id: 'i', kind: 'url', content: 'x', atMs: '0' })),
        null,
      )
    })
    test('every known kind round-trips with its payload, and only that payload', () => {
      for (const kind of ['url', 'path', 'line', 'block', 'image']) {
        const ok = deserialize(wrap({ type: 'insert', id: 'i', kind, content: 'x', atMs: 7 }))
        assert.deepEqual(
          ok?.entries[0],
          { type: 'insert', id: 'i', kind, content: 'x', atMs: 7 },
          `kind ${kind} must survive intact`,
        )
        // The same kind with a broken payload must still be refused — this is
        // what distinguishes payload validation from a kind allowlist.
        assert.equal(
          deserialize(wrap({ type: 'insert', id: 'i', kind, atMs: 7 })),
          null,
          `kind ${kind} with no content must be refused`,
        )
        assert.equal(
          deserialize(wrap({ type: 'insert', id: 'i', kind, content: 'x' })),
          null,
          `kind ${kind} with no atMs must be refused`,
        )
      }
    })
  })

  test('ONE bad entry invalidates the WHOLE pad — no half-valid delivery', () => {
    const raw = JSON.stringify({
      id: 'a',
      origin: 'task',
      createdAt: 0,
      updatedAt: 0,
      entries: [
        { type: 'segment', id: 's1', text: 'good', startMs: 0, endMs: 1 },
        { type: 'segment', id: 's2', startMs: 2, endMs: 3 },
      ],
    })
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
