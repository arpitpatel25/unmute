import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentChat, conciseLine, AGENT_CHAT_MAX_TURNS } from './conversation'

test('the chat keeps both sides, in the order they were said', () => {
  const c = new AgentChat()
  c.said('what is on my plate?', 1)
  c.answered('Eleven open, four blocked on you.', 2)
  assert.deepEqual(c.snapshot().turns.map((t) => [t.role, t.text]), [
    ['user', 'what is on my plate?'],
    ['agent', 'Eleven open, four blocked on you.'],
  ])
})

test('a purge takes everything — it does not trim', () => {
  // Continuity has decided the model is starting fresh. Leaving the user
  // reading an exchange the Agent can no longer refer to is the one outcome
  // worse than an empty panel.
  const c = new AgentChat()
  c.said('a', 1); c.answered('b', 2)
  c.purge()
  assert.ok(c.isEmpty)
  assert.equal(c.snapshot().runId, null)
})

test('the last answer is what the card shows, not the last turn', () => {
  const c = new AgentChat()
  c.answered('the answer', 1)
  c.said('a follow-up question', 2)
  assert.equal(c.lastAnswer()?.text, 'the answer')
})

test('full conversation text never falls off a presentation limit', () => {
  const c = new AgentChat()
  for (let i = 0; i < AGENT_CHAT_MAX_TURNS + 20; i += 1) c.said(`turn ${i}`, i)
  assert.equal(c.length, AGENT_CHAT_MAX_TURNS + 20)
  assert.equal(c.snapshot().turns[0].text, 'turn 0')
  assert.equal(c.snapshot().turns.at(-1)!.text, `turn ${AGENT_CHAT_MAX_TURNS + 19}`)
})

test('empty turns are not turns', () => {
  const c = new AgentChat()
  c.said('   ', 1)
  c.answered('\n\n', 2)
  assert.ok(c.isEmpty)
})

test('the concise line is the first paragraph, not a summary of the answer', () => {
  assert.equal(conciseLine('Eleven open.\n\nHere is the detail, at length.'), 'Eleven open.')
})

test('a long first paragraph is cut, and says so', () => {
  const line = conciseLine('x'.repeat(400))
  assert.ok(line.length <= 141)
  assert.ok(line.endsWith('…'), 'the ellipsis is the promise that there is more')
})

test('it prefers a sentence boundary when one is near the cap', () => {
  const text = `${'a'.repeat(120)}. and then a great deal more that will not fit at all.`
  const line = conciseLine(text)
  assert.ok(line.endsWith('.'))
  assert.ok(!line.endsWith('…'))
})

test('newlines inside the first paragraph collapse — a card is one line', () => {
  assert.equal(conciseLine('two\nlines'), 'two lines')
})
