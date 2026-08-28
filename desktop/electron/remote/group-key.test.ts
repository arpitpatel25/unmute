import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupKey, sameGroup } from './group-key.ts'

test('case and surrounding whitespace never make two groups', () => {
  assert.equal(groupKey('Unmute'), groupKey('unmute'))
  assert.equal(groupKey('  unmute  '), groupKey('unmute'))
  assert.equal(groupKey('UNMUTE'), groupKey('Unmute'))
})

test('internal whitespace is collapsed, not preserved', () => {
  assert.equal(groupKey('unmute   cloud'), groupKey('unmute cloud'))
  assert.equal(groupKey('unmute\tcloud'), groupKey('unmute cloud'))
})

test('separators fold, so a directory basename matches what the user says', () => {
  // The import path derives a group from a cwd basename ("unmute-cloud"); the
  // router derives one from speech ("unmute cloud"). They must be one group.
  assert.equal(groupKey('unmute-cloud'), groupKey('unmute cloud'))
  assert.equal(groupKey('unmute_cloud'), groupKey('unmute cloud'))
})

test('quotes and trailing punctuation are stripped', () => {
  assert.equal(groupKey('"unmute"'), groupKey('unmute'))
  assert.equal(groupKey('unmute.'), groupKey('unmute'))
  assert.equal(groupKey("'unmute'"), groupKey('unmute'))
})

test('genuinely different streams keep different keys', () => {
  assert.notEqual(groupKey('unmute'), groupKey('unmute AI'))
  assert.notEqual(groupKey('launch video'), groupKey('launch'))
})

test('an absent or blank label has no key', () => {
  assert.equal(groupKey(''), '')
  assert.equal(groupKey('   '), '')
  assert.equal(groupKey(null), '')
  assert.equal(groupKey(undefined), '')
  assert.equal(groupKey('---'), '')
})

test('sameGroup answers the question every comparison site actually asks', () => {
  assert.equal(sameGroup('Unmute Cloud', 'unmute-cloud'), true)
  assert.equal(sameGroup('unmute', 'unmute AI'), false)
  // Two blanks are not "the same group" — they are both ungrouped, which is
  // the absence of a group rather than a shared one.
  assert.equal(sameGroup('', ''), false)
  assert.equal(sameGroup(null, undefined), false)
})
