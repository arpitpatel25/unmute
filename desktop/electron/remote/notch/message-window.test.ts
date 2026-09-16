import { test } from 'node:test'
import assert from 'node:assert/strict'
import { messageWindow } from './message-window'
import type { Block } from '../blocks'
test('starts with ten messages and loads older messages without losing work between them', () => {
  const blocks: Block[] = Array.from({ length: 24 }, (_, i) => [...(i % 2 ? [{ kind: 'reasoning', text: 'work' } as Block] : []), { kind: 'message', role: i % 2 ? 'assistant' : 'user', text: String(i) } as Block]).flat()
  const page = messageWindow(blocks, 10)
  assert.equal(page.blocks.filter(b => b.kind === 'message').length, 10)
  assert.equal(page.olderMessages, 14)
  assert.equal(page.blocks[0].kind === 'message' && page.blocks[0].text, '14')
  assert.equal(messageWindow(blocks, 20).olderMessages, 4)
  assert.equal(messageWindow(blocks, 30).blocks.length, blocks.length)
})

test('Claude commentary does not evict the latest user prompt from the visible message page', () => {
  const blocks: Block[] = [{ kind: 'message', role: 'user', text: 'Question' }]
  for (let i = 0; i < 20; i++) blocks.push({ kind: 'message', role: 'assistant', text: `Working ${i}` }, { kind: 'reasoning', text: 'work' })
  blocks.push({ kind: 'message', role: 'assistant', text: 'Answer' })
  assert.equal(messageWindow(blocks).olderMessages, 0)
  assert.deepEqual(messageWindow(blocks).blocks, blocks)
})

/** The Agent's chat marks where the model's memory begins. The page is cut at a
 *  message, so without this the divider sat one row above the window — hidden —
 *  and the visible chat looked continuous with a session the model forgot. */
test('a session divider directly above the visible page comes with it', () => {
  const blocks: Block[] = [
    { kind: 'message', role: 'user', text: 'old' }, { kind: 'message', role: 'assistant', text: 'old answer' },
    { kind: 'sessionBoundary', text: 'New conversation' },
    { kind: 'message', role: 'user', text: 'new' }, { kind: 'message', role: 'assistant', text: 'new answer' },
  ]
  const page = messageWindow(blocks, 2)
  assert.equal(page.olderMessages, 2)
  assert.deepEqual(page.blocks.map(b => b.kind), ['sessionBoundary', 'message', 'message'])
})

test('a session divider does not stop the reply before it counting as a message', () => {
  const blocks: Block[] = [
    { kind: 'message', role: 'user', text: 'old' }, { kind: 'message', role: 'assistant', text: 'old answer' },
    { kind: 'sessionBoundary', text: 'New conversation' },
    { kind: 'message', role: 'user', text: 'new' },
  ]
  assert.equal(messageWindow(blocks, 1).olderMessages, 2)
})
