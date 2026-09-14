import test from 'node:test'
import assert from 'node:assert/strict'

import { liftProposals } from './proposals'

test('lifts a valid trailing proposals block and strips it from the text', () => {
  const text = 'Here is what I found.\n\n```unmute-proposals\n[{"title": "Reply to Priya", "detail": "Say thanks and confirm 3pm."}]\n```'
  const { text: cleaned, proposals } = liftProposals(text, () => 'fixed-id')
  assert.equal(cleaned, 'Here is what I found.')
  assert.equal(proposals.length, 1)
  assert.deepEqual(proposals[0], { id: 'fixed-id', title: 'Reply to Priya', detail: 'Say thanks and confirm 3pm.', state: 'open' })
})

test('invalid JSON in the block leaves the text unchanged and yields no proposals', () => {
  const text = 'Result.\n\n```unmute-proposals\nnot json\n```'
  const { text: cleaned, proposals } = liftProposals(text)
  assert.equal(cleaned, text)
  assert.deepEqual(proposals, [])
})

test('caps at 5 proposals even when more are present', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, detail: `D${i}` }))
  const text = `Result.\n\n\`\`\`unmute-proposals\n${JSON.stringify(items)}\n\`\`\``
  const { proposals } = liftProposals(text)
  assert.equal(proposals.length, 5)
  assert.deepEqual(proposals.map(p => p.title), ['T0', 'T1', 'T2', 'T3', 'T4'])
})

test('uses only the LAST fenced unmute-proposals block when more than one is present', () => {
  const text = [
    '```unmute-proposals',
    '[{"title": "First block", "detail": "should be ignored"}]',
    '```',
    '',
    'more text',
    '',
    '```unmute-proposals',
    '[{"title": "Second block", "detail": "should win"}]',
    '```',
  ].join('\n')
  const { text: cleaned, proposals } = liftProposals(text)
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0].title, 'Second block')
  assert.match(cleaned, /First block/)
  assert.doesNotMatch(cleaned, /Second block/)
})

test('generates ids via randomUUID by default', () => {
  const text = '```unmute-proposals\n[{"title": "A", "detail": "B"}]\n```'
  const { proposals } = liftProposals(text)
  assert.match(proposals[0].id, /^[0-9a-f-]{36}$/)
})

test('drops items missing a non-empty title or detail, and enforces length caps', () => {
  const items = [
    { title: '', detail: 'ok' },
    { title: 'ok', detail: '' },
    { title: 'x'.repeat(121), detail: 'ok' },
    { title: 'ok', detail: 'y'.repeat(2001) },
    { title: 'Keep me', detail: 'This one is valid.' },
  ]
  const text = `\`\`\`unmute-proposals\n${JSON.stringify(items)}\n\`\`\``
  const { proposals } = liftProposals(text)
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0].title, 'Keep me')
})

test('no fenced block at all leaves text unchanged with no proposals', () => {
  const text = 'Just a plain result, nothing fenced.'
  const { text: cleaned, proposals } = liftProposals(text)
  assert.equal(cleaned, text)
  assert.deepEqual(proposals, [])
})
