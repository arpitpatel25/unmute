import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectSurface, GENERAL_SURFACE } from './surface.ts'

test('detects gmail', () => {
  assert.equal(detectSurface('check my email for events'), 'gmail')
  assert.equal(detectSurface('scan my inboxes'), 'gmail')
})
test('detects sheets / calendar / canva', () => {
  assert.equal(detectSurface('add it to the spreadsheet'), 'google-sheets')
  assert.equal(detectSurface('what meetings do I have'), 'google-calendar')
  assert.equal(detectSurface('open my latest canva design'), 'canva')
})
test('falls back to general', () => {
  assert.equal(detectSurface('refactor the auth module'), GENERAL_SURFACE)
})
