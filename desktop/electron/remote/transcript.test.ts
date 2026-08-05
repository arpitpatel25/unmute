import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAssistantLine,
  parseTranscript,
  lastAssistantText,
  hadSideEffects,
  urlsIn,
} from './transcript.ts'

const line = (o: unknown) => JSON.stringify(o)
const assistant = (blocks: unknown[]) => line({ type: 'assistant', message: { content: blocks } })

test('a text block is kept; thinking and tool traffic are dropped', () => {
  // Measured on a real session: 1.9% of the transcript was `text`. The other
  // 98% is exactly what must never reach the user or a spoken headline.
  const m = parseAssistantLine(assistant([
    { type: 'thinking', thinking: 'let me work out what to do' },
    { type: 'text', text: 'Here is the answer.' },
    { type: 'tool_use', name: 'Read', input: {} },
  ]))
  assert.equal(m?.text, 'Here is the answer.')
  assert.deepEqual(m?.tools, ['Read'])
})

test('non-assistant lines and junk are ignored, never thrown', () => {
  assert.equal(parseAssistantLine(line({ type: 'user', message: { content: 'hi' } })), null)
  assert.equal(parseAssistantLine(line({ type: 'ai-title', title: 'x' })), null)
  assert.equal(parseAssistantLine('{"type":"assistant","message":{"conte'), null) // caught mid-write
  assert.equal(parseAssistantLine(''), null)
})

test('lastAssistantText skips the tool-only turns, which are most of them', () => {
  const raw = [
    assistant([{ type: 'text', text: 'first' }]),
    assistant([{ type: 'tool_use', name: 'Bash', input: {} }]),
    assistant([{ type: 'tool_use', name: 'Read', input: {} }]),
  ].join('\n')
  assert.equal(lastAssistantText(parseTranscript(raw)), 'first')
})

test('a partial trailing line does not lose the good lines before it', () => {
  const raw = `${assistant([{ type: 'text', text: 'done' }])}\n{"type":"assist`
  assert.equal(lastAssistantText(parseTranscript(raw)), 'done')
})

test('hadSideEffects: reading is info, writing is act', () => {
  const readOnly = parseTranscript([
    assistant([{ type: 'tool_use', name: 'Read', input: {} }]),
    assistant([{ type: 'tool_use', name: 'Grep', input: {} }]),
  ].join('\n'))
  assert.equal(hadSideEffects(readOnly), false)

  for (const tool of ['Write', 'Edit', 'Bash', 'mcp__unmute__unmute_create_task']) {
    const t = parseTranscript(assistant([{ type: 'tool_use', name: tool, input: {} }]))
    assert.equal(hadSideEffects(t), true, `${tool} should count as a side effect`)
  }
})

test('urlsIn: de-duplicated, in order, without the sentence punctuation', () => {
  assert.deepEqual(
    urlsIn('Opened https://example.com/a. Also https://example.com/a and https://x.dev/b?q=1'),
    ['https://example.com/a', 'https://x.dev/b?q=1'],
  )
  assert.deepEqual(urlsIn('nothing here'), [])
})
