import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ROLLUP_AT, ROLLUP_KEEP, buildPrompt, emptySummary, mergeSummary, renderTurns,
  rollUp, updateSummary, type SessionSummary,
} from './summary'

const turns = [
  { role: 'user' as const, text: 'cut the intro off the promo video' },
  { role: 'assistant' as const, text: 'Trimmed the first 4 seconds and re-exported.' },
]

/**
 * THE RULE THE WHOLE DESIGN RESTS ON. Updating by feeding a model
 * (old summary + new turns) is lossy compression applied repeatedly — by turn
 * 200, turn 5 has been rewritten forty times and is fiction. `done` only ever
 * grows, so nothing is ever re-compressed.
 */
test('done is append-only — an existing item is never rewritten', () => {
  const prior: SessionSummary = {
    about: 'Editing the Q3 promo video',
    done: ['imported the raw footage', 'picked the music bed'],
    standing: 'mid-edit',
    touched: ['promo.mp4'],
  }
  const merged = mergeSummary(prior, {
    about: 'Editing the Q3 promo video',
    done: ['imported the footage differently', 'cut the intro'],
    standing: 'intro cut, awaiting review',
    touched: ['promo.mp4', 'music.wav'],
  })
  assert.deepEqual(merged.done.slice(0, 2), prior.done, 'the originals survive verbatim')
  assert.equal(merged.done.length, 4)
  assert.equal(merged.standing, 'intro cut, awaiting review', 'standing IS replaced')
  assert.deepEqual(merged.touched, ['promo.mp4', 'music.wav'], 'touched accumulates as a set')
})

test('a model that repeats itself cannot duplicate the record', () => {
  const prior: SessionSummary = { about: 'x', done: ['cut the intro'], standing: '', touched: [] }
  const merged = mergeSummary(prior, { done: ['Cut The Intro', 'cut the intro', 'added titles'] })
  assert.deepEqual(merged.done, ['cut the intro', 'added titles'])
})

test('a model that drops about keeps the one already recorded', () => {
  const prior: SessionSummary = { about: 'Editing the promo video', done: [], standing: '', touched: [] }
  assert.equal(mergeSummary(prior, { done: ['did a thing'] }).about, 'Editing the promo video')
})

test('about is revisable when the session genuinely became something else', () => {
  const prior: SessionSummary = { about: 'Fixing the build', done: ['fixed the build'], standing: '', touched: [] }
  const merged = mergeSummary(prior, { about: 'Redesigning the notch', done: ['moved the pill'] })
  assert.equal(merged.about, 'Redesigning the notch')
  assert.deepEqual(merged.done, ['fixed the build', 'moved the pill'], 'history is not rewritten with it')
})

test('junk from the model is ignored rather than stored', () => {
  const merged = mergeSummary(emptySummary(), { about: 42, done: 'not an array', touched: [null, 7, 'real.ts'] })
  assert.equal(merged.about, '')
  assert.deepEqual(merged.done, [])
  assert.deepEqual(merged.touched, ['real.ts'])
})

/** A rollup that summarised the summary would reintroduce the drift the
 *  append-only list exists to prevent, so it is arithmetic, not a model call. */
test('a long list rolls up without calling anything', () => {
  const done = Array.from({ length: ROLLUP_AT + 10 }, (_, i) => `step ${i}`)
  const rolled = rollUp({ about: 'a', done, standing: '', touched: [] })
  assert.equal(rolled.done.length, ROLLUP_KEEP + 1)
  assert.match(rolled.done[0]!, /earlier steps, beginning: step 0/)
  assert.equal(rolled.done[rolled.done.length - 1], `step ${ROLLUP_AT + 9}`)
})

test('a short list is left alone', () => {
  const done = ['one', 'two']
  assert.deepEqual(rollUp({ about: 'a', done, standing: '', touched: [] }).done, done)
})

test('the prompt carries what is already recorded, so the model does not repeat it', () => {
  const prior: SessionSummary = {
    about: 'Editing the promo video', done: ['cut the intro'], standing: 'mid-edit', touched: ['promo.mp4'],
  }
  const prompt = buildPrompt(prior, turns)
  assert.match(prompt, /Already recorded — about: Editing the promo video/)
  assert.match(prompt, /- cut the intro/)
  assert.match(prompt, /Already recorded — touched: promo\.mp4/)
  assert.match(prompt, /USER: cut the intro off the promo video/)
  assert.match(prompt, /ASSISTANT: Trimmed the first 4 seconds/)
})

test('a first summary is not told to preserve an about it does not have', () => {
  const prompt = buildPrompt(emptySummary(), turns)
  // The phrase appears once in the rules as a reference; what must be absent
  // is the DATA sections it points at.
  assert.doesNotMatch(prompt, /Already recorded — /)
  assert.doesNotMatch(prompt, /Keep "about" unless/)
})

test('both sides of the conversation reach the model', () => {
  const rendered = renderTurns(turns)
  assert.match(rendered, /^USER: /)
  assert.match(rendered, /ASSISTANT: Trimmed/)
})

test('an enormous turn is truncated before it reaches a prompt', () => {
  const rendered = renderTurns([{ role: 'assistant', text: 'x'.repeat(50_000) }])
  assert.ok(rendered.length < 3_000)
  assert.match(rendered, /…$/)
})

/**
 * If a failed call advanced the cursor, those turns would never be read again
 * and the record would carry a permanent hole.
 */
test('a model failure returns the prior summary and says so', async () => {
  const prior: SessionSummary = { about: 'kept', done: ['kept item'], standing: '', touched: [] }
  const failed = await updateSummary(prior, turns, async () => ({ ok: false, error: 'no binary' }), JSON.parse)
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.summary, prior)
})

test('unparseable output is a failure, not a summary', async () => {
  const prior = emptySummary()
  const run = async () => ({ ok: true as const, output: 'I think the session was about video editing!' })
  const result = await updateSummary(prior, turns, run, JSON.parse)
  assert.equal(result.ok, false)
  assert.deepEqual(result.summary, prior)
})

test('an array is not a summary', async () => {
  const result = await updateSummary(emptySummary(), turns, async () => ({ ok: true as const, output: '[1,2]' }), JSON.parse)
  assert.equal(result.ok, false)
})

test('no new turns is a success that calls nothing', async () => {
  let called = false
  const result = await updateSummary(emptySummary(), [], async () => { called = true; return { ok: true as const, output: '{}' } }, JSON.parse)
  assert.equal(result.ok, true)
  assert.equal(called, false)
})

test('a good answer folds in', async () => {
  const run = async () => ({
    ok: true as const,
    output: JSON.stringify({
      about: 'Editing the Q3 promo video',
      done: ['cut the 4-second intro', 're-exported at 4K'],
      standing: 'awaiting review',
      touched: ['promo.mp4'],
    }),
  })
  const result = await updateSummary(emptySummary(), turns, run, JSON.parse)
  assert.equal(result.ok, true)
  assert.equal(result.summary.about, 'Editing the Q3 promo video')
  assert.deepEqual(result.summary.done, ['cut the 4-second intro', 're-exported at 4K'])
  assert.equal(result.summary.standing, 'awaiting review')
})
