import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAssistantLine,
  parseTranscript,
  lastAssistantText,
  hadSideEffects,
  endedOnSelfContinuation,
  urlsIn,
  parseTurnLine,
  parseTurns,
  latestExchange,
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

test('endedOnSelfContinuation: true when THIS turn scheduled its own wakeup', () => {
  const raw = [
    userStr('start the plan'),
    assistant([{ type: 'tool_use', name: 'Agent', input: { description: 'Task 2' } }]),
    assistant([{ type: 'tool_use', name: 'ScheduleWakeup', input: { delaySeconds: 400 } }]),
    assistant([{ type: 'text', text: 'Continuing autonomously — reviewing now.' }]),
  ].join('\n')
  assert.equal(endedOnSelfContinuation(raw), true)
})

test('endedOnSelfContinuation: false for an ordinary finished turn', () => {
  const raw = [
    userStr('what does this function do'),
    assistant([{ type: 'tool_use', name: 'Read', input: {} }]),
    assistant([{ type: 'text', text: 'It parses the config file.' }]),
  ].join('\n')
  assert.equal(endedOnSelfContinuation(raw), false)
})

test('endedOnSelfContinuation: scoped to the CURRENT turn — an earlier loop iteration must not haunt a later, real finish', () => {
  const raw = [
    userStr('start the plan'),
    assistant([{ type: 'tool_use', name: 'ScheduleWakeup', input: { delaySeconds: 400 } }]),
    assistant([{ type: 'text', text: 'Continuing autonomously.' }]),
    userStr('keep going'),
    assistant([{ type: 'tool_use', name: 'Write', input: {} }]),
    assistant([{ type: 'text', text: 'All done — the feature is fully implemented.' }]),
  ].join('\n')
  assert.equal(endedOnSelfContinuation(raw), false)
})

test('endedOnSelfContinuation: no transcript yet is not a checkpoint', () => {
  assert.equal(endedOnSelfContinuation(''), false)
})

test('urlsIn: de-duplicated, in order, without the sentence punctuation', () => {
  assert.deepEqual(
    urlsIn('Opened https://example.com/a. Also https://example.com/a and https://x.dev/b?q=1'),
    ['https://example.com/a', 'https://x.dev/b?q=1'],
  )
  assert.deepEqual(urlsIn('nothing here'), [])
})

// ─── The conversation, both sides ───────────────────────────────────────────

const userStr = (text: string, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', message: { content: text }, timestamp: '2026-08-06T00:00:00Z', uuid: 'u1', ...extra })

test('a user turn is real when message.content is a STRING', () => {
  // Measured on a live session: 17 of 211 user-typed lines were a human. The
  // other 194 were tool_result being fed back. This is the whole filter.
  const t = parseTurnLine(userStr('summarize the pricing thread'))
  assert.equal(t?.role, 'user')
  assert.equal(t?.text, 'summarize the pricing thread')
  assert.equal(t?.at, '2026-08-06T00:00:00Z')
  assert.equal(t?.uuid, 'u1')
})

test('a user turn whose content is an ARRAY is tool output, never shown', () => {
  const toolResult = line({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'file contents…' }] },
    toolUseResult: { stdout: '…' },
  })
  assert.equal(parseTurnLine(toolResult), null)
})

test('subagent turns are excluded — they are not the user\'s conversation', () => {
  // Without this one Task call floods the panel with an exchange the user
  // never had and never saw.
  assert.equal(parseTurnLine(userStr('inner agent prompt', { isSidechain: true })), null)
  assert.equal(parseTurnLine(line({
    type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'inner reply' }] },
  })), null)
})

test('metadata lines are not conversation', () => {
  for (const type of ['system', 'attachment', 'file-history-snapshot', 'ai-title', 'mode', 'last-prompt']) {
    assert.equal(parseTurnLine(line({ type, message: { content: 'x' } })), null, `${type} leaked in`)
  }
})

test('an assistant turn with only tools contributes nothing', () => {
  assert.equal(parseTurnLine(assistant([{ type: 'tool_use', name: 'Read', input: {} }])), null)
  assert.equal(parseTurnLine(assistant([{ type: 'thinking', thinking: 'hmm' }])), null)
})

test('latestExchange returns the ask and the reply, in order', () => {
  const turns = parseTurns([
    userStr('first question'),
    assistant([{ type: 'text', text: 'first answer' }]),
    userStr('second question'),
    assistant([{ type: 'tool_use', name: 'Read', input: {} }]),
    assistant([{ type: 'text', text: 'second answer' }]),
  ].join('\n'))
  assert.deepEqual(latestExchange(turns).map((t) => [t.role, t.text]), [
    ['user', 'second question'],
    ['assistant', 'second answer'],
  ])
})

test('mid-first-turn shows the ask alone rather than nothing', () => {
  // A card that is blank while the model works reads as broken.
  const turns = parseTurns(userStr('do the thing'))
  assert.deepEqual(latestExchange(turns).map((t) => t.text), ['do the thing'])
})

test('an empty session yields an empty exchange, not a crash', () => {
  assert.deepEqual(latestExchange([]), [])
  assert.deepEqual(latestExchange(parseTurns('{"broken')), [])
})
