import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suppressionFingerprint, isSuppressed } from './curator-match.ts'

test('suppressionFingerprint is stable across identical inputs', () => {
  const a = suppressionFingerprint('file-taxes', 'quarterly tax filing flow')
  const b = suppressionFingerprint('file-taxes', 'quarterly tax filing flow')
  assert.equal(a, b)
})

test('suppressionFingerprint normalizes signature (case + whitespace) before hashing', () => {
  const a = suppressionFingerprint('file-taxes', 'Quarterly   Tax\nFiling Flow')
  const b = suppressionFingerprint('file-taxes', 'quarterly tax filing flow')
  assert.equal(a, b)
})

test('suppressionFingerprint differs across draft names for the same signature', () => {
  const a = suppressionFingerprint('file-taxes', 'sig')
  const b = suppressionFingerprint('other-name', 'sig')
  assert.notEqual(a, b)
})

test('isSuppressed matches a prior rejection by name', () => {
  assert.equal(isSuppressed('file-taxes', [{ at: 'x', name: 'file-taxes' }]), true)
})

test('isSuppressed is false for an unrelated name', () => {
  assert.equal(isSuppressed('file-taxes', [{ at: 'x', name: 'pr-review' }]), false)
})

test('isSuppressed is false against an empty rejection list', () => {
  assert.equal(isSuppressed('file-taxes', []), false)
})
