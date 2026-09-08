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
