import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseSummaryOutput, generateNotes, buildSummaryInput, DEFAULT_SUMMARY_INSTRUCTIONS } from './notesSummary'
import type { TranscriptSegment } from './transcriptMerge'
import type { HeadlessProvider } from './headlessAgent'

function seg(channel: 'mic' | 'system', text: string, speakerName?: string | null): TranscriptSegment {
  return { channel, text, startMs: 0, endMs: 1000, speakerName }
}

describe('parseSummaryOutput', () => {
  test('a full valid response parses every field', () => {
    const out = parseSummaryOutput(JSON.stringify({
      title: 'Budget Review',
      summary: 'Discussed Q3 budget.',
      keyPoints: ['Point A'],
      decisions: ['Approved the plan'],
      actionItems: ['Alice to send the doc'],
    }))
    assert.deepEqual(out, {
      title: 'Budget Review',
      summary: 'Discussed Q3 budget.',
      keyPoints: ['Point A'],
      decisions: ['Approved the plan'],
      actionItems: ['Alice to send the doc'],
      openQuestions: [],
    })
  })

  test('missing title is null', () => {
    assert.equal(parseSummaryOutput(JSON.stringify({ summary: 'x' })), null)
  })

  test('missing summary is null', () => {
    assert.equal(parseSummaryOutput(JSON.stringify({ title: 'x' })), null)
  })

  test('missing optional arrays default to []', () => {
    const out = parseSummaryOutput(JSON.stringify({ title: 'T', summary: 'S' }))
    assert.deepEqual(out, { title: 'T', summary: 'S', keyPoints: [], decisions: [], actionItems: [], openQuestions: [] })
  })

  test('openQuestions parses like the other list fields', () => {
    const out = parseSummaryOutput(JSON.stringify({ title: 'T', summary: 'S', openQuestions: ['Which harness?', 5, 'Popup or panel?'] }))
    assert.deepEqual(out?.openQuestions, ['Which harness?', 'Popup or panel?'])
  })

  test('malformed JSON is null', () => {
    assert.equal(parseSummaryOutput('not json {{{'), null)
  })

  test('non-string title/summary is null', () => {
    assert.equal(parseSummaryOutput(JSON.stringify({ title: 5, summary: 'x' })), null)
    assert.equal(parseSummaryOutput(JSON.stringify({ title: 'x', summary: null })), null)
  })

  test('non-string entries in the list fields are filtered out, not thrown', () => {
    const out = parseSummaryOutput(JSON.stringify({ title: 'T', summary: 'S', keyPoints: ['a', 5, null, 'b'] }))
    assert.deepEqual(out?.keyPoints, ['a', 'b'])
  })

  test('a ```json fenced response (the real, live-observed Claude Code shape) still parses', () => {
    const fenced = '```json\n{"title":"T","summary":"S"}\n```'
    assert.deepEqual(parseSummaryOutput(fenced), { title: 'T', summary: 'S', keyPoints: [], decisions: [], actionItems: [], openQuestions: [] })
  })
})

describe('buildSummaryInput', () => {
  test('labels lines exactly like the Transcript tab does — mic as "You", system as its speaker name or "Them" — since the ownership rule tells the model to use these literal labels', () => {
    const input = buildSummaryInput([seg('mic', 'hello'), seg('system', 'hi there'), seg('system', 'hey', 'Priya')], 'MY INSTRUCTIONS')
    const instructionsIndex = input.indexOf('MY INSTRUCTIONS')
    assert.ok(instructionsIndex > 0, 'fixed preamble should come before the instructions')
    assert.ok(input.endsWith('You: hello\nThem: hi there\nPriya: hey'))
    assert.ok(input.includes('no markdown code fence'))
  })

  test('the fixed contract carries the language, garbled-content, and decision-ownership rules — none of it user-supplied', () => {
    const input = buildSummaryInput([seg('mic', 'a')], 'MY INSTRUCTIONS')
    assert.ok(input.includes('LANGUAGE'))
    assert.ok(input.includes('GARBLED CONTENT'))
    assert.ok(input.includes('openQuestions'))
  })

  test('the language rule names no specific language — it must generalize', () => {
    const input = buildSummaryInput([seg('mic', 'a')], 'MY INSTRUCTIONS')
    const languageSection = input.slice(input.indexOf('LANGUAGE'), input.indexOf('GARBLED CONTENT'))
    for (const langName of ['Hindi', 'Spanish', 'Mandarin', 'French', 'English']) {
      assert.ok(!languageSection.includes(langName), `should not name ${langName} specifically`)
    }
  })
})

describe('generateNotes', () => {
  function fakeRunner(response: { ok: true; output: string } | { ok: false; error: string }) {
    return async (_provider: HeadlessProvider, _input: string) => response
  }

  test('happy path returns parsed notes', async () => {
    const runner = fakeRunner({ ok: true, output: JSON.stringify({ title: 'T', summary: 'S' }) })
    const result = await generateNotes([seg('mic', 'hi')], 'claude', undefined, runner)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.notes.title, 'T')
  })

  test('the call itself failing is ok:false', async () => {
    const runner = fakeRunner({ ok: false, error: 'boom' })
    const result = await generateNotes([seg('mic', 'hi')], 'claude', undefined, runner)
    assert.deepEqual(result, { ok: false, error: 'boom' })
  })

  test('a response missing title/summary is ok:false', async () => {
    const runner = fakeRunner({ ok: true, output: JSON.stringify({ keyPoints: ['x'] }) })
    const result = await generateNotes([seg('mic', 'hi')], 'claude', undefined, runner)
    assert.equal(result.ok, false)
  })

  test('a ```json fenced response is ok:true, not a false failure — this was the live bug', async () => {
    const runner = fakeRunner({ ok: true, output: '```json\n{"title":"T","summary":"S"}\n```' })
    const result = await generateNotes([seg('mic', 'hi')], 'claude', undefined, runner)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.notes.title, 'T')
  })

  test('openQuestions flows through end to end', async () => {
    const runner = fakeRunner({ ok: true, output: JSON.stringify({ title: 'T', summary: 'S', openQuestions: ['Which harness?'] }) })
    const result = await generateNotes([seg('mic', 'hi')], 'claude', undefined, runner)
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.notes.openQuestions, ['Which harness?'])
  })

  test('DEFAULT_SUMMARY_INSTRUCTIONS is real instructions text, not a placeholder', () => {
    assert.ok(DEFAULT_SUMMARY_INSTRUCTIONS.length > 50)
    assert.match(DEFAULT_SUMMARY_INSTRUCTIONS, /title/i)
  })
})
