import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectSurface, GENERAL_SURFACE, SURFACES, isKnownSurface, normalizeSurface } from './surface.ts'

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

test('detects the surfaces seen live (x / jiohotstar / whatsapp / macos)', () => {
  assert.equal(detectSurface('write a tweet about the launch'), 'x')
  assert.equal(detectSurface('reply to the tweet and fix grammar'), 'x')
  assert.equal(detectSurface('open Modern Family on JioHotstar'), 'jiohotstar')
  assert.equal(detectSurface('open WhatsApp for me'), 'whatsapp')
  assert.equal(detectSurface('completely uninstall HeyClicky from my Mac'), 'macos')
})

test('every detected surface is in the canonical SURFACES vocabulary', () => {
  for (const s of ['x', 'jiohotstar', 'whatsapp', 'macos', 'gmail', 'google-sheets', 'canva', 'youtube']) {
    assert.ok(SURFACES.includes(s), `${s} must be canonical`)
    assert.ok(isKnownSurface(s))
  }
  assert.equal(isKnownSurface('frobnicate'), false)
  assert.equal(isKnownSurface('general'), false) // general is the fallback, not a stored surface
})

test('normalizeSurface keeps canonical, lowercases, drops off-vocabulary to undefined', () => {
  assert.equal(normalizeSurface('X'), 'x')
  assert.equal(normalizeSurface('google-sheets'), 'google-sheets')
  assert.equal(normalizeSurface('frobnicate'), undefined)
  assert.equal(normalizeSurface(''), undefined)
  assert.equal(normalizeSurface(undefined), undefined)
})
