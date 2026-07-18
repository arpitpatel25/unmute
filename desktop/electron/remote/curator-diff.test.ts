import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unifiedDiff } from './curator-diff.ts'

test('identical inputs → empty string', () => {
  assert.equal(unifiedDiff('a\nb\nc', 'a\nb\nc'), '')
  assert.equal(unifiedDiff('', ''), '')
  // A lone trailing-newline difference is not a real change.
  assert.equal(unifiedDiff('a\nb\n', 'a\nb'), '')
})

test('pure addition: trailing line appended with context', () => {
  assert.equal(
    unifiedDiff('a\nb\nc', 'a\nb\nc\nd'),
    ['@@ -1,3 +1,4 @@', ' a', ' b', ' c', '+d'].join('\n'),
  )
})

test('pure deletion: line removed with surrounding context', () => {
  assert.equal(
    unifiedDiff('a\nb\nc', 'a\nc'),
    ['@@ -1,3 +1,2 @@', ' a', '-b', ' c'].join('\n'),
  )
})

test('a change in the middle keeps surrounding context and drops far context', () => {
  const old = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n')
  const neu = old.replace('l5', 'L5')
  const d = unifiedDiff(old, neu)
  assert.ok(d.startsWith('@@ -2,7 +2,7 @@'))   // 3 lines context around the single change
  assert.ok(d.includes('-l5'))
  assert.ok(d.includes('+L5'))
  assert.ok(d.includes(' l2'))                 // near context kept
  assert.ok(d.includes(' l8'))
  assert.ok(!d.includes(' l1'))                // far context dropped
  assert.ok(!d.includes('l10'))
})

test('empty-old (new file) → all additions, -0,0 header', () => {
  assert.equal(
    unifiedDiff('', 'x\ny'),
    ['@@ -0,0 +1,2 @@', '+x', '+y'].join('\n'),
  )
})

test('full deletion (empty-new) → all removals, +0,0 header', () => {
  assert.equal(
    unifiedDiff('x\ny', ''),
    ['@@ -1,2 +0,0 @@', '-x', '-y'].join('\n'),
  )
})

test('two distant changes produce two separate hunks', () => {
  const old = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n')
  const neu = old.replace('l2', 'L2').replace('l18', 'L18')
  const d = unifiedDiff(old, neu)
  const headers = d.split('\n').filter((ln) => ln.startsWith('@@'))
  assert.equal(headers.length, 2)
})
