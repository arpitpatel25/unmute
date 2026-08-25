import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseCleanupOutput, cleanupTranscript, buildCleanupInput, DEFAULT_CLEANUP_PROMPT } from './transcriptCleanup'
import type { TranscriptSegment } from './transcriptMerge'
import type { HeadlessProvider } from './headlessAgent'

function seg(text: string, overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return { channel: 'mic', text, startMs: 0, endMs: 1000, ...overrides }
}

describe('parseCleanupOutput', () => {
  test('a full valid response corrects every segment by id', () => {
    const segments = [seg('helo'), seg('wrold')]
    const out = parseCleanupOutput(JSON.stringify([{ id: 0, text: 'hello' }, { id: 1, text: 'world' }]), segments)
    assert.deepEqual(out.map((s) => s.text), ['hello', 'world'])
  })

  test('a missing id falls back to that segment\'s own original text', () => {
    const segments = [seg('helo'), seg('wrold')]
    const out = parseCleanupOutput(JSON.stringify([{ id: 0, text: 'hello' }]), segments)
    assert.deepEqual(out.map((s) => s.text), ['hello', 'wrold'])
  })

  test('a duplicate id: first occurrence wins, the rest are ignored', () => {
    const segments = [seg('helo')]
    const out = parseCleanupOutput(JSON.stringify([{ id: 0, text: 'first' }, { id: 0, text: 'second' }]), segments)
    assert.deepEqual(out.map((s) => s.text), ['first'])
  })

  test('malformed JSON entirely: every segment falls back', () => {
    const segments = [seg('helo'), seg('wrold')]
    const out = parseCleanupOutput('not json at all {{{', segments)
    assert.deepEqual(out.map((s) => s.text), ['helo', 'wrold'])
  })

  test('empty text for an id falls back — an empty correction is not valid', () => {
    const segments = [seg('helo')]
    const out = parseCleanupOutput(JSON.stringify([{ id: 0, text: '' }]), segments)
    assert.deepEqual(out.map((s) => s.text), ['helo'])
  })

  test('an id outside the segment range is ignored, doesn\'t crash', () => {
    const segments = [seg('helo')]
    const out = parseCleanupOutput(JSON.stringify([{ id: 0, text: 'hello' }, { id: 99, text: 'ghost' }]), segments)
    assert.deepEqual(out.map((s) => s.text), ['hello'])
  })

  test('never reads channel/startMs/endMs/speakerName from the response — only text changes', () => {
    const segments = [seg('helo', { channel: 'system', startMs: 500, endMs: 900, speakerName: 'Alice' })]
    const out = parseCleanupOutput(JSON.stringify([{ id: 0, text: 'hello', channel: 'mic', startMs: 0, endMs: 0 }]), segments)
    assert.deepEqual(out[0], { channel: 'system', text: 'hello', startMs: 500, endMs: 900, speakerName: 'Alice' })
  })
})

describe('buildCleanupInput', () => {
  test('sends only {id, text} pairs, in order, prefixed with the prompt', () => {
    const segments = [seg('a'), seg('b')]
    const input = buildCleanupInput(segments, 'PROMPT')
    assert.ok(input.startsWith('PROMPT'))
    assert.deepEqual(JSON.parse(input.slice('PROMPT\n\n'.length)), [{ id: 0, text: 'a' }, { id: 1, text: 'b' }])
  })
})

describe('cleanupTranscript', () => {
  function fakeRunner(response: { ok: true; output: string } | { ok: false; error: string }) {
    return async (_provider: HeadlessProvider, _input: string) => response
  }

  test('happy path returns corrected segments', async () => {
    const runner = fakeRunner({ ok: true, output: JSON.stringify([{ id: 0, text: 'hello' }]) })
    const result = await cleanupTranscript([seg('helo')], 'claude', undefined, runner)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.segments[0].text, 'hello')
  })

  test('the call itself failing is ok:false, with the underlying error', async () => {
    const runner = fakeRunner({ ok: false, error: 'boom' })
    const result = await cleanupTranscript([seg('helo')], 'claude', undefined, runner)
    assert.deepEqual(result, { ok: false, error: 'boom' })
  })

  test('a response that is not valid JSON at all is ok:false', async () => {
    const runner = fakeRunner({ ok: true, output: 'not json {{{' })
    const result = await cleanupTranscript([seg('helo')], 'claude', undefined, runner)
    assert.equal(result.ok, false)
  })

  test('a promptOverride is used instead of the default when provided', async () => {
    let sentInput = ''
    const runner = async (_p: HeadlessProvider, input: string) => { sentInput = input; return { ok: true as const, output: '[]' } }
    await cleanupTranscript([seg('helo')], 'claude', 'CUSTOM PROMPT', runner)
    assert.ok(sentInput.startsWith('CUSTOM PROMPT'))
  })

  test('DEFAULT_CLEANUP_PROMPT is real prompt text, not a placeholder', () => {
    assert.ok(DEFAULT_CLEANUP_PROMPT.length > 50)
    assert.match(DEFAULT_CLEANUP_PROMPT, /id.*text/i)
  })
})
