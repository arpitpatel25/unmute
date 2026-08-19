import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_CAPTION_LENGTH,
  captionDwellMs,
  fitCaption,
  CAPTION_MIN_DWELL_MS,
  CAPTION_MAX_DWELL_MS,
} from './caption'

// ── dwell ─────────────────────────────────────────────────────────────────
// Video captions are timed to speech. These have no clock, so length is the
// only honest proxy: too short and it is missed, too long and it is litter.

test('a short answer still stays long enough to read', () => {
  assert.equal(captionDwellMs('Saved.'), CAPTION_MIN_DWELL_MS)
})

test('dwell grows with length', () => {
  assert.ok(captionDwellMs('Saved your competitor list.') > captionDwellMs('Saved.'))
})

test('the longest permitted caption never outstays the ceiling', () => {
  assert.equal(captionDwellMs('x'.repeat(MAX_CAPTION_LENGTH)), CAPTION_MAX_DWELL_MS)
})

test('an empty caption is not shown at all', () => {
  assert.equal(captionDwellMs(''), 0)
  assert.equal(captionDwellMs('   '), 0)
})

// ── the cap ───────────────────────────────────────────────────────────────
// The model writes ONE user-facing string and it IS the answer. Past ~200
// characters it stops being a caption and becomes a panel — which is the
// "separate app" feeling the whole surface exists to avoid.

test('an answer within the cap passes through untouched', () => {
  const text = 'Copied Rishi Patidar’s email to your clipboard.'
  assert.deepEqual(fitCaption(text), { text, truncated: false })
})

// Truncation is a last resort, not the mechanism. The model is instructed to
// put detail where the user asked for it and say where it went; if it ignores
// that, a hard clip is still better than a panel — but it must be VISIBLE as a
// clip rather than a sentence that merely stops.
test('an over-long answer is clipped visibly, never silently', () => {
  const result = fitCaption('x'.repeat(MAX_CAPTION_LENGTH + 200))
  assert.equal(result.truncated, true)
  assert.ok(result.text.length <= MAX_CAPTION_LENGTH)
  assert.ok(result.text.endsWith('…'), 'a clipped caption must look clipped')
})

test('markup the medium cannot render is stripped, not shown raw', () => {
  const result = fitCaption('**Saved** your `competitor` list.\n\n> and a quote')
  assert.equal(result.text.includes('**'), false)
  assert.equal(result.text.includes('`'), false)
  assert.equal(result.text.includes('>'), false)
  assert.ok(result.text.startsWith('Saved your competitor list.'))
})

test('a multi-line answer becomes one line', () => {
  assert.equal(fitCaption('Saved.\nTwo records now.').text, 'Saved. Two records now.')
})

test('whitespace is normalised so the caption never renders ragged', () => {
  assert.equal(fitCaption('  Saved    your   list.  ').text, 'Saved your list.')
})

test('nothing to say produces nothing to show', () => {
  assert.deepEqual(fitCaption('   '), { text: '', truncated: false })
})
