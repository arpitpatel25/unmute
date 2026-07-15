import { test } from 'node:test'
import assert from 'node:assert'
import { promptTail } from './promptTail'

test('empty/null/short-junk input yields empty string', () => {
  assert.equal(promptTail(null), '')
  assert.equal(promptTail(''), '')
  assert.equal(promptTail('   '), '')
  assert.equal(promptTail('.'), '')
})

test('short clean text passes through trimmed', () => {
  assert.equal(promptTail('  We are testing unmute. '), 'We are testing unmute.')
})

test('long text keeps only the tail, cut at a word boundary', () => {
  const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ')
  const tail = promptTail(words, 60)
  assert.ok(tail.length <= 60)
  assert.ok(!tail.startsWith(' '))
  assert.ok(tail.endsWith('word99'))
  assert.ok(words.endsWith(tail))
})

test('known hallucination-y tails are rejected', () => {
  assert.equal(promptTail('Thank you.'), '')
  assert.equal(promptTail('Thanks for watching!'), '')
})
