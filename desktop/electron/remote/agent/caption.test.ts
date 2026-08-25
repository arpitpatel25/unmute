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

import { presentAnswer, readerText, READER_THRESHOLD } from './caption'

test('a short answer is a caption, timed to its length', () => {
  const shown = presentAnswer('Saved your competitor list.')
  assert.equal(shown.surface, 'caption')
  assert.equal(shown.text, 'Saved your competitor list.')
  assert.ok(shown.dwellMs >= 2_500)
})

test('nothing to say opens nothing', () => {
  assert.deepEqual(presentAnswer('   '), { surface: 'caption', text: '', dwellMs: 0 })
})

/** Held open, a two-line answer is a small box the user must go and dismiss. */
test('a near miss is still clipped rather than held', () => {
  const shown = presentAnswer('x'.repeat(MAX_CAPTION_LENGTH + 20))
  assert.equal(shown.surface, 'caption')
  assert.match(shown.text, /…$/)
})

/**
 * "Summarise that meeting note" has an answer that IS the deliverable. A
 * clipped deliverable is a broken promise wearing a tick.
 */
test('an answer that is genuinely long is held, whole, with no clock', () => {
  const long = 'This is the summary. '.repeat(60)
  const shown = presentAnswer(long)
  assert.equal(shown.surface, 'reader')
  assert.equal(shown.dwellMs, 0)
  assert.ok(shown.text.length > READER_THRESHOLD)
  assert.doesNotMatch(shown.text, /…$/)
})

test('the reader keeps paragraphs but never markup', () => {
  const shown = presentAnswer([
    '# Heading', '', '**bold** and `code`', '', '> quoted', '', 'x'.repeat(READER_THRESHOLD),
  ].join('\n'))
  assert.equal(shown.surface, 'reader')
  assert.doesNotMatch(shown.text, /[#*`>]/)
  assert.match(shown.text, /\n\n/, 'paragraphs survive')
})

test('reader cleanup collapses runs without joining paragraphs', () => {
  assert.equal(readerText('a  \t b\n\n\n\nc'), 'a b\n\nc')
})
