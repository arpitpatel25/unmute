import { test, describe } from 'node:test'
import assert from 'node:assert'
import { render, fenceFor } from './insertRender'
import { emptyPad, addSegment, addInsert } from './captureBuffer'
import type { Pad } from './types'

function build(): Pad {
  let p = emptyPad('p', 'task', 0)
  p = addSegment(p, { id: 's1', text: 'go through the thread', startMs: 0, endMs: 10_000 })
  p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://slack.com/x', atMs: 12_000 })
  p = addSegment(p, { id: 's2', text: 'and tell me what you think', startMs: 14_000, endMs: 20_000 })
  return p
}

describe('inline kinds read as one sentence', () => {
  test('a url joins the speech inline at the cursor', () => {
    assert.equal(
      render(build(), 'cursor').text,
      'go through the thread https://slack.com/x and tell me what you think',
    )
  })
  test('and inline for a task too — a url carries no ambiguity anywhere', () => {
    assert.equal(
      render(build(), 'task').text,
      'go through the thread https://slack.com/x and tell me what you think',
    )
  })
  test('no doubled spaces when speech already ends in one', () => {
    let p = emptyPad('p', 'cursor', 0)
    p = addSegment(p, { id: 's1', text: 'look at ', startMs: 0, endMs: 1 })
    p = addInsert(p, { id: 'i1', kind: 'url', content: 'https://a.com', atMs: 2 })
    assert.equal(render(p, 'cursor').text, 'look at https://a.com')
  })
})

describe('block kinds are fenced in every destination', () => {
  test('a multi-line paste is fenced', () => {
    let p = emptyPad('p', 'task', 0)
    p = addSegment(p, { id: 's1', text: 'I got this', startMs: 0, endMs: 1 })
    p = addInsert(p, { id: 'i1', kind: 'block', content: 'line one\nline two', atMs: 2 })
    p = addSegment(p, { id: 's2', text: 'please fix it', startMs: 3, endMs: 4 })
    assert.equal(
      render(p, 'task').text,
      'I got this\n\n```\nline one\nline two\n```\n\nplease fix it',
    )
  })
  test('fenced at the cursor too — readability, not provenance', () => {
    let p = emptyPad('p', 'cursor', 0)
    p = addInsert(p, { id: 'i1', kind: 'block', content: 'a\nb', atMs: 1 })
    assert.equal(render(p, 'cursor').text, '```\na\nb\n```')
  })
})

describe('fenceFor escapes content containing backticks', () => {
  test('plain content uses three', () => {
    assert.equal(fenceFor('hello'), '```')
  })
  test('content with a three-run uses four', () => {
    assert.equal(fenceFor('a ``` b'), '````')
  })
  test('content with a five-run uses six', () => {
    assert.equal(fenceFor('`````'), '``````')
  })
  test('inline single backticks do not extend the fence', () => {
    assert.equal(fenceFor('use `x` here'), '```')
  })
  test('a fenced block containing a fence still round-trips', () => {
    let p = emptyPad('p', 'task', 0)
    p = addInsert(p, { id: 'i1', kind: 'block', content: '```js\nx\n```', atMs: 1 })
    assert.equal(render(p, 'task').text, '````\n```js\nx\n```\n````')
  })
})

describe('images', () => {
  test('a task gets a real reference and the path as an attachment', () => {
    let p = emptyPad('p', 'task', 0)
    p = addSegment(p, { id: 's1', text: 'look at this', startMs: 0, endMs: 1 })
    p = addInsert(p, { id: 'i1', kind: 'image', content: '/tmp/shot.png', atMs: 2 })
    const r = render(p, 'task')
    assert.match(r.text, /\/tmp\/shot\.png/)
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
    assert.equal(render(p, 'task').text, 'https://a.com')
  })
})

test('two identical blocks both render (no indexOf aliasing)', () => {
  let p = emptyPad('p', 'task', 0)
  p = addInsert(p, { id: 'i1', kind: 'block', content: 'same\nsame', atMs: 1 })
  p = addInsert(p, { id: 'i2', kind: 'block', content: 'same\nsame', atMs: 2 })
  const t = render(p, 'task').text
  assert.equal(t.split('```').length - 1, 4)
})
