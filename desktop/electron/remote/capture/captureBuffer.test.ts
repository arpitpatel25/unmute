// desktop/electron/remote/capture/captureBuffer.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert'
import {
  emptyPad, addSegment, addInsert, removeEntry, ordered, isEmpty, setSegmentEnd, setSegmentText,
} from './captureBuffer'

const pad0 = () => emptyPad('pad1', 'task', 1000)

describe('emptyPad', () => {
  test('starts empty with its origin recorded', () => {
    const p = pad0()
    assert.equal(p.id, 'pad1')
    assert.equal(p.origin, 'task')
    assert.equal(p.entries.length, 0)
    assert.equal(isEmpty(p), true)
  })
})

describe('ordering', () => {
  test('an insert lands between the segments it fell between', () => {
    let p = pad0()
    p = addSegment(p, { id: 's1', text: 'first', startMs: 0, endMs: 10_000 })
    p = addSegment(p, { id: 's2', text: 'second', startMs: 20_000, endMs: 30_000 })
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://x', atMs: 15_000 })
    assert.deepEqual(ordered(p).map((e) => e.id), ['s1', 'i1', 's2'])
  })

  test('out-of-order arrival still orders by time, not insertion', () => {
    let p = pad0()
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://x', atMs: 15_000 })
    p = addSegment(p, { id: 's1', text: 'first', startMs: 0, endMs: 10_000 })
    assert.deepEqual(ordered(p).map((e) => e.id), ['s1', 'i1'])
  })

  test('an insert inside a segment span sorts after that segment starts', () => {
    let p = pad0()
    p = addSegment(p, { id: 's1', text: 'talking', startMs: 0, endMs: 30_000 })
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://x', atMs: 12_400 })
    assert.deepEqual(ordered(p).map((e) => e.id), ['s1', 'i1'])
  })

  test('ties are stable — a segment starting at the insert time comes first', () => {
    let p = pad0()
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://x', atMs: 5_000 })
    p = addSegment(p, { id: 's1', text: 'x', startMs: 5_000, endMs: 9_000 })
    assert.deepEqual(ordered(p).map((e) => e.id), ['s1', 'i1'])
  })
})

describe('mutation is immutable', () => {
  test('addSegment does not modify the input pad', () => {
    const p = pad0()
    const q = addSegment(p, { id: 's1', text: 'a', startMs: 0, endMs: 1 })
    assert.equal(p.entries.length, 0)
    assert.equal(q.entries.length, 1)
  })

  test('updatedAt advances on every mutation', () => {
    const p = pad0()
    const q = addInsert(p, { id: 'i1', kind: 'line', content: 'x', atMs: 5, now: 2000 })
    assert.equal(q.updatedAt, 2000)
  })
})

describe('removeEntry', () => {
  test('removes a single insert, leaving segments intact', () => {
    let p = pad0()
    p = addSegment(p, { id: 's1', text: 'a', startMs: 0, endMs: 10 })
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://x', atMs: 5 })
    p = removeEntry(p, 'i1')
    assert.deepEqual(ordered(p).map((e) => e.id), ['s1'])
  })

  test('removes a whole segment, leaving inserts intact', () => {
    let p = pad0()
    p = addSegment(p, { id: 's1', text: 'a', startMs: 0, endMs: 10 })
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://x', atMs: 5 })
    p = removeEntry(p, 's1')
    assert.deepEqual(ordered(p).map((e) => e.id), ['i1'])
  })

  test('removing the last entry makes the pad empty again', () => {
    let p = pad0()
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://x', atMs: 5 })
    p = removeEntry(p, 'i1')
    assert.equal(isEmpty(p), true)
  })

  test('removing an unknown id is a no-op, not a throw', () => {
    let p = pad0()
    p = addSegment(p, { id: 's1', text: 'a', startMs: 0, endMs: 10 })
    assert.equal(removeEntry(p, 'nope').entries.length, 1)
  })
})

describe('setSegmentText', () => {
  test('fills in transcription that arrives after the segment was created', () => {
    let p = pad0()
    p = addSegment(p, { id: 's1', text: '', startMs: 0, endMs: 10 })
    p = setSegmentText(p, 's1', 'the words')
    const s = ordered(p)[0]
    assert.equal(s.type === 'segment' && s.text, 'the words')
  })

  test('an unknown id is a no-op', () => {
    const p = setSegmentText(pad0(), 'nope', 'x')
    assert.equal(p.entries.length, 0)
  })
})

describe('setSegmentEnd', () => {
  // The end is known the instant the mic goes cold; the text lands 30-45s
  // later. Two writes, two moments, so two functions.
  test('stamps the end without disturbing the text', () => {
    let p = pad0()
    p = addSegment(p, { id: 's1', text: 'said', startMs: 4_000, endMs: 0 })
    p = setSegmentEnd(p, 's1', 18_000)
    const s = ordered(p)[0]
    assert.equal(s.type === 'segment' && s.endMs, 18_000)
    assert.equal(s.type === 'segment' && s.text, 'said')
    assert.equal(s.type === 'segment' && s.startMs, 4_000, 'and the start is where it was')
  })

  test('an unknown id is a no-op — Escape can have removed the segment already', () => {
    const p = setSegmentEnd(pad0(), 'nope', 5)
    assert.equal(p.entries.length, 0)
  })

  test('it does not reorder — the start is the sort key, not the end', () => {
    let p = pad0()
    p = addSegment(p, { id: 's1', text: 'first', startMs: 0, endMs: 0 })
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://a.com', atMs: 2_000 })
    p = setSegmentEnd(p, 's1', 30_000)
    assert.deepEqual(ordered(p).map((e) => e.id), ['s1', 'i1'])
  })
})

describe('isEmpty means NOTHING DELIVERABLE, not zero entries', () => {
  // Every capture opens a segment with `text: ''` the instant recording starts,
  // so an armed tap on silence has an entry and holds nothing. Counting entries
  // made that pad "content": it settled, it pinned a panel open on a row
  // reading "Still transcribing…" that nothing would ever fill, and every
  // destination button on it rendered ''.
  test('a pad of one blank segment holds nothing', () => {
    let p = pad0()
    p = addSegment(p, { id: 's1', text: '', startMs: 0, endMs: 0 })
    assert.equal(p.entries.length, 1)
    assert.equal(isEmpty(p), true)
  })

  test('whitespace is not speech', () => {
    let p = pad0()
    p = addSegment(p, { id: 's1', text: '   \n ', startMs: 0, endMs: 0 })
    assert.equal(isEmpty(p), true)
  })

  test('one real word anywhere is content', () => {
    let p = pad0()
    p = addSegment(p, { id: 's1', text: '', startMs: 0, endMs: 0 })
    p = addSegment(p, { id: 's2', text: 'the thing I said', startMs: 10, endMs: 20 })
    assert.equal(isEmpty(p), false)
  })

  test('an insert alone is content — including an image, which renders to nothing at a cursor', () => {
    let p = pad0()
    p = addSegment(p, { id: 's1', text: '', startMs: 0, endMs: 0 })
    p = addInsert(p, { id: 'i1', kind: 'image', content: '/tmp/shot.png', atMs: 5 })
    assert.equal(isEmpty(p), false, 'the user captured it deliberately, and a task can take it')
  })
})
