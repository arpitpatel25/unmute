import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseSummaryOutput, generateNotes, buildSummaryInput, buildDegradedNotes, DEFAULT_SUMMARY_INSTRUCTIONS, type NoteProvider } from './notesSummary'
import type { TranscriptSegment } from './transcriptMerge'

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

  test('an empty Markdown note is rejected', () => {
    assert.equal(parseSummaryOutput(JSON.stringify({ title: 'T', summary: '' })), null)
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

  test('trims document fields and drops whitespace-only list items', () => {
    const out = parseSummaryOutput(JSON.stringify({
      title: '  Planning  ',
      summary: '  ## Next steps\n- Ship it  ',
      keyPoints: ['  useful  ', '   '],
    }))
    assert.equal(out?.title, 'Planning')
    assert.equal(out?.summary, '## Next steps\n- Ship it')
    assert.deepEqual(out?.keyPoints, ['useful'])
  })

  test('a ```json fenced response (the real, live-observed Claude Code shape) still parses', () => {
    const fenced = '```json\n{"title":"T","summary":"S"}\n```'
    assert.deepEqual(parseSummaryOutput(fenced), { title: 'T', summary: 'S', keyPoints: [], decisions: [], actionItems: [], openQuestions: [] })
  })
})

describe('buildSummaryInput', () => {
  test('labels source channels without implying an unnamed system stream is a person', () => {
    const input = buildSummaryInput([seg('mic', 'hello'), seg('system', 'hi there'), seg('system', 'hey', 'Priya')], 'MY INSTRUCTIONS')
    const instructionsIndex = input.indexOf('MY INSTRUCTIONS')
    assert.ok(instructionsIndex > 0, 'fixed preamble should come before the instructions')
    assert.ok(input.endsWith('Microphone: hello\nSystem audio: hi there\nPriya: hey'))
    assert.ok(input.includes('no markdown code fence'))
  })

  test('the fixed contract carries the language, garbled-content, and decision-ownership rules — none of it user-supplied', () => {
    const input = buildSummaryInput([seg('mic', 'a')], 'MY INSTRUCTIONS')
    assert.ok(input.includes('LANGUAGE'))
    assert.ok(input.includes('GARBLED CONTENT'))
    assert.ok(input.includes('openQuestions'))
  })

  test('the language rule explicitly understands English/Hindi code-switching and requires English notes', () => {
    const input = buildSummaryInput([seg('mic', 'a')], 'MY INSTRUCTIONS')
    const languageSection = input.slice(input.indexOf('LANGUAGE'), input.indexOf('GARBLED CONTENT'))
    assert.ok(languageSection.includes('Hindi'))
    assert.ok(languageSection.includes('Hinglish'))
    assert.ok(languageSection.includes('Devanagari'))
    assert.ok(languageSection.includes('clear English'))
  })

  test('sends uninterrupted same-speaker chunks to the notes agent as one turn', () => {
    const input = buildSummaryInput([
      seg('mic', 'The first capture chunk.'),
      seg('mic', 'The same thought continues.'),
      seg('system', 'Now the other person replies.'),
    ], 'MY INSTRUCTIONS')

    assert.ok(input.endsWith(
      'Microphone: The first capture chunk. The same thought continues.\n' +
      'System audio: Now the other person replies.'
    ))
  })
})

describe('buildDegradedNotes', () => {
  test('the raw output becomes the summary verbatim; every list is empty; title is left blank, never invented', () => {
    const notes = buildDegradedNotes('The team discussed the Q3 budget and agreed to revisit next week.')
    assert.deepEqual(notes, {
      title: '',
      summary: 'The team discussed the Q3 budget and agreed to revisit next week.',
      keyPoints: [],
      decisions: [],
      actionItems: [],
      openQuestions: [],
    })
  })

  test('whitespace-only output has nothing worth keeping — null, not an empty summary', () => {
    assert.equal(buildDegradedNotes('   \n  '), null)
    assert.equal(buildDegradedNotes(''), null)
  })

  test('does not render a malformed JSON notes payload as literal Notes text', () => {
    assert.equal(buildDegradedNotes(JSON.stringify({ title: '', summary: '', keyPoints: [] })), null)
  })
})

describe('generateNotes', () => {
  function fakeRunner(response: { ok: true; output: string } | { ok: false; error: string }) {
    return async (_provider: NoteProvider, _input: string) => response
  }

  test('happy path returns parsed notes, not degraded', async () => {
    const runner = fakeRunner({ ok: true, output: JSON.stringify({ title: 'T', summary: 'S' }) })
    const result = await generateNotes([seg('mic', 'hi')], 'claude', undefined, runner)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.notes.title, 'T')
      assert.equal(result.degraded, undefined)
    }
  })

  test('the call itself failing is ok:false', async () => {
    const runner = fakeRunner({ ok: false, error: 'boom' })
    const result = await generateNotes([seg('mic', 'hi')], 'claude', undefined, runner)
    assert.deepEqual(result, { ok: false, error: 'boom' })
  })

  test('a response that is not the expected JSON shape but has real content is a degraded success, not a failure — the generation is not wasted', async () => {
    const runner = fakeRunner({ ok: true, output: 'The meeting covered budget and timeline, no formal decisions were made.' })
    const result = await generateNotes([seg('mic', 'hi')], 'claude', undefined, runner)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.degraded, true)
      assert.equal(result.notes.title, '')
      assert.equal(result.notes.summary, 'The meeting covered budget and timeline, no formal decisions were made.')
      assert.deepEqual(result.notes.keyPoints, [])
    }
  })

  test('a response missing title/summary is rejected instead of rendering malformed JSON as notes', async () => {
    const runner = fakeRunner({ ok: true, output: JSON.stringify({ keyPoints: ['x'] }) })
    const result = await generateNotes([seg('mic', 'hi')], 'claude', undefined, runner)
    assert.deepEqual(result, { ok: false, error: 'response missing title/summary or unparseable' })
  })

  test('retries once when an agent returns empty structured notes and accepts the corrected response', async () => {
    let calls = 0
    const runner = async (_provider: NoteProvider, input: string) => {
      calls++
      if (calls === 1) return { ok: true as const, output: JSON.stringify({ title: '', summary: '', keyPoints: [] }) }
      assert.match(input, /CORRECTION FOR THIS RETRY/)
      return { ok: true as const, output: JSON.stringify({ title: 'Playback Test', summary: '## Result\n\n- Audio playback was tested.' }) }
    }
    const result = await generateNotes([seg('mic', 'I am testing audio playback.')], 'claude', undefined, runner)
    assert.equal(calls, 2)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.notes.title, 'Playback Test')
  })

  test('a call that succeeds with genuinely empty output is still ok:false — nothing to salvage', async () => {
    const runner = fakeRunner({ ok: true, output: '   ' })
    const result = await generateNotes([seg('mic', 'hi')], 'claude', undefined, runner)
    assert.equal(result.ok, false)
  })

  test('does not display a generic “recording was unclear” message as meeting notes', async () => {
    const runner = fakeRunner({ ok: true, output: JSON.stringify({
      title: 'Notes',
      summary: '## Notes\n- Large portions of the recording were unclear and could not be used.',
    }) })
    const result = await generateNotes([seg('mic', 'garbled audio')], 'claude', undefined, runner)
    assert.deepEqual(result, { ok: false, error: 'Not enough clear speech was captured to generate meeting notes.' })
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
