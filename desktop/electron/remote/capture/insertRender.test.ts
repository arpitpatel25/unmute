import { test, describe } from 'node:test'
import assert from 'node:assert'
import { render } from './insertRender'
import { emptyPad, addSegment, addInsert } from './captureBuffer'
import type { Pad } from './types'

function build(): Pad {
  let p = emptyPad('p', 'task', 0)
  p = addSegment(p, { id: 's1', text: 'go through the thread', startMs: 0, endMs: 10_000 })
  p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://slack.com/x', atMs: 12_000 })
  p = addSegment(p, { id: 's2', text: 'and tell me what you think', startMs: 14_000, endMs: 20_000 })
  return p
}

// NOT MARKDOWN, AND NOTHING INLINE.
//
// This text is pasted wherever the cursor is — Notes, a terminal, a chat box.
// Backtick fences arrive there as literal ``` characters. And a copied link
// merged into the sentence is indistinguishable from a link the user SAID,
// which is the one distinction an insert exists to make.
describe('every insert is quoted and stands alone', () => {
  test('a url gets a blank line and quotes, not inline placement', () => {
    assert.equal(
      render(build(), 'cursor').text,
      'go through the thread\n\n"https://slack.com/x"\n\nand tell me what you think',
    )
  })

  test('the same at a task destination — the marker does not vary by where it lands', () => {
    assert.equal(
      render(build(), 'task').text,
      'go through the thread\n\n"https://slack.com/x"\n\nand tell me what you think',
    )
  })

  test('a single copied line is marked exactly like a long one', () => {
    let p = emptyPad('p', 'cursor', 0)
    p = addSegment(p, { id: 's1', text: 'it says', startMs: 0, endMs: 1 })
    p = addInsert(p, { id: 'i1', kind: 'line', content: 'the build is broken', atMs: 2 })
    assert.equal(render(p, 'cursor').text, 'it says\n\n"the build is broken"')
  })

  test('a multi-line paste keeps its newlines inside the quotes', () => {
    let p = emptyPad('p', 'task', 0)
    p = addSegment(p, { id: 's1', text: 'I got this', startMs: 0, endMs: 1 })
    p = addInsert(p, { id: 'i1', kind: 'block', content: 'line one\nline two', atMs: 2 })
    p = addSegment(p, { id: 's2', text: 'please fix it', startMs: 3, endMs: 4 })
    assert.equal(
      render(p, 'task').text,
      'I got this\n\n"line one\nline two"\n\nplease fix it',
    )
  })

  test('no backticks reach the output, whatever the content contains', () => {
    let p = emptyPad('p', 'cursor', 0)
    p = addInsert(p, { id: 'i1', kind: 'block', content: 'a ``` b', atMs: 1 })
    const out = render(p, 'cursor').text
    assert.equal(out, '"a ``` b"')
    assert.equal(out.startsWith('```'), false, 'a fence must never be produced')
  })
})

describe('images', () => {
  test('a task gets the real attachment without leaking its path into the prompt', () => {
    let p = emptyPad('p', 'task', 0)
    p = addSegment(p, { id: 's1', text: 'look at this', startMs: 0, endMs: 1 })
    p = addInsert(p, { id: 'i1', kind: 'image', content: '/tmp/shot.png', atMs: 2 })
    const r = render(p, 'task')
    assert.equal(r.text, 'look at this')
    assert.deepEqual(r.attachments, ['/tmp/shot.png'])
  })
  test('the cursor keeps an image OUT OF THE TEXT but still delivers it', () => {
    // A text field cannot hold a path, so the path must not appear — but
    // dropping the image altogether threw away something the user deliberately
    // captured, and the pre-branch delivery did paste staged screenshots. It
    // leaves as an ATTACHMENT, which delivery hands over as real bytes through
    // the pasteboard.
    let p = emptyPad('p', 'cursor', 0)
    p = addSegment(p, { id: 's1', text: 'look at this', startMs: 0, endMs: 1 })
    p = addInsert(p, { id: 'i1', kind: 'image', content: '/tmp/shot.png', atMs: 2 })
    const r = render(p, 'cursor')
    assert.equal(r.text, 'look at this', 'no path in the text')
    assert.deepEqual(r.attachments, ['/tmp/shot.png'], 'and nothing silently lost')
  })

  test('several images reach the cursor in the order they were captured', () => {
    let p = emptyPad('p', 'cursor', 0)
    p = addSegment(p, { id: 's1', text: 'these two', startMs: 0, endMs: 1 })
    p = addInsert(p, { id: 'i2', kind: 'image', content: '/tmp/second.png', atMs: 9 })
    p = addInsert(p, { id: 'i1', kind: 'image', content: '/tmp/first.png', atMs: 2 })
    assert.deepEqual(render(p, 'cursor').attachments, ['/tmp/first.png', '/tmp/second.png'])
  })
})

describe('nothing is ever asserted about meaning', () => {
  test('no label appears anywhere in the output', () => {
    let p = emptyPad('p', 'task', 0)
    p = addInsert(p, { id: 'i1', kind: 'block', content: 'x\ny', atMs: 1 })
    const t = render(p, 'task').text
    for (const banned of ['copied', 'selected', 'context', 'pasted', 'user']) {
      assert.ok(!t.toLowerCase().includes(banned), `must not contain "${banned}"`)
    }
  })
})

describe('edges', () => {
  test('an empty pad renders to empty string', () => {
    assert.equal(render(emptyPad('p', 'task', 0), 'task').text, '')
  })
  test('a segment with no transcription yet is skipped, not rendered blank', () => {
    let p = emptyPad('p', 'task', 0)
    p = addSegment(p, { id: 's1', text: '', startMs: 0, endMs: 1 })
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://a.com', atMs: 2 })
    assert.equal(render(p, 'task').text, '"https://a.com"')
  })
})

test('two identical inserts both render (no indexOf aliasing)', () => {
  let p = emptyPad('p', 'task', 0)
  p = addInsert(p, { id: 'i1', kind: 'block', content: 'same\nsame', atMs: 1 })
  p = addInsert(p, { id: 'i2', kind: 'block', content: 'same\nsame', atMs: 2 })
  // Two by value, two in the output: the separator is computed against the
  // real previous piece, not the first one that happens to be equal to it.
  assert.equal(render(p, 'task').text, '"same\nsame"\n\n"same\nsame"')
})
