import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseCleanupOutput, cleanupTranscript, buildCleanupInput } from './transcriptCleanup'
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

  test('empty text for an id is applied, not a fallback — the model is confirming a hallucination', () => {
    const segments = [seg('helo')]
    const out = parseCleanupOutput(JSON.stringify([{ id: 0, text: '' }]), segments)
    assert.deepEqual(out.map((s) => s.text), [''])
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

  test('a ```json fenced response (the real, live-observed Claude Code shape) is still corrected, not a total fallback', () => {
    const segments = [seg('helo'), seg('wrold')]
    const fenced = '```json\n[{"id":0,"text":"hello"},{"id":1,"text":"world"}]\n```'
    const out = parseCleanupOutput(fenced, segments)
    assert.deepEqual(out.map((s) => s.text), ['hello', 'world'])
  })

  test('a non-empty alt/note pair is applied alongside an unchanged text', () => {
    const segments = [seg('so Jesus is')]
    const out = parseCleanupOutput(JSON.stringify([{ id: 0, text: 'so Jesus is', alt: 'so yeh cheez hai', note: 'hi' }]), segments)
    assert.deepEqual(out[0], { channel: 'mic', text: 'so Jesus is', startMs: 0, endMs: 1000, alt: 'so yeh cheez hai', note: 'hi' })
  })

  test('empty-string alt/note are not applied — a segment with nothing to add stays clean', () => {
    const segments = [seg('hello')]
    const out = parseCleanupOutput(JSON.stringify([{ id: 0, text: 'hello', alt: '', note: '' }]), segments)
    assert.deepEqual(out[0], { channel: 'mic', text: 'hello', startMs: 0, endMs: 1000 })
    assert.ok(!('alt' in out[0]))
    assert.ok(!('note' in out[0]))
  })

  test('a non-string alt/note is ignored, not applied', () => {
    const segments = [seg('hello')]
    const out = parseCleanupOutput(JSON.stringify([{ id: 0, text: 'hello', alt: 5, note: null }]), segments)
    assert.deepEqual(out[0], { channel: 'mic', text: 'hello', startMs: 0, endMs: 1000 })
  })
})

describe('buildCleanupInput', () => {
  test('sends only {id, text} pairs, in order', () => {
    const segments = [seg('a'), seg('b')]
    const input = buildCleanupInput(segments)
    const payloadStart = input.indexOf('[{')
    assert.deepEqual(JSON.parse(input.slice(payloadStart)), [{ id: 0, text: 'a' }, { id: 1, text: 'b' }])
  })

  test('the prompt carries the hallucination rule, the output contract, and the language-recovery rule — none of it user-supplied', () => {
    const input = buildCleanupInput([seg('a')])
    assert.ok(input.includes('hallucinated'))
    assert.ok(input.includes('no markdown code fence'))
    assert.ok(input.includes('CODE-SWITCHING'))
    assert.ok(input.includes('alt'))
    assert.ok(input.includes('note'))
  })

  test('the language-recovery rule names no specific language — it must generalize, not assume Hindi/English or any other pair', () => {
    const input = buildCleanupInput([seg('a')])
    const codeSwitchSection = input.slice(input.indexOf('CODE-SWITCHING'), input.indexOf('HALLUCINATED SEGMENTS'))
    for (const langName of ['Hindi', 'Spanish', 'Mandarin', 'French', 'Devanagari']) {
      assert.ok(!codeSwitchSection.includes(langName), `should not name ${langName} specifically`)
    }
  })
})

describe('cleanupTranscript', () => {
  function fakeRunner(response: { ok: true; output: string } | { ok: false; error: string }) {
    return async (_provider: HeadlessProvider, _input: string) => response
  }

  test('happy path returns corrected segments', async () => {
    const runner = fakeRunner({ ok: true, output: JSON.stringify([{ id: 0, text: 'hello' }]) })
    const result = await cleanupTranscript([seg('helo')], 'claude', runner)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.segments[0].text, 'hello')
  })

  test('the call itself failing is ok:false, with the underlying error', async () => {
    const runner = fakeRunner({ ok: false, error: 'boom' })
    const result = await cleanupTranscript([seg('helo')], 'claude', runner)
    assert.deepEqual(result, { ok: false, error: 'boom' })
  })

  test('a response that is not valid JSON at all is ok:false', async () => {
    const runner = fakeRunner({ ok: true, output: 'not json {{{' })
    const result = await cleanupTranscript([seg('helo')], 'claude', runner)
    assert.equal(result.ok, false)
  })

  test('a ```json fenced response is ok:true, not a false failure — this was the live bug', async () => {
    const runner = fakeRunner({ ok: true, output: '```json\n[{"id":0,"text":"hello"}]\n```' })
    const result = await cleanupTranscript([seg('helo')], 'claude', runner)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.segments[0].text, 'hello')
  })

  test('a segment the model emptied is dropped from the final result, not kept as a blank line', async () => {
    const runner = fakeRunner({ ok: true, output: JSON.stringify([{ id: 0, text: 'hello' }, { id: 1, text: '' }]) })
    const result = await cleanupTranscript([seg('helo'), seg('thnk u')], 'claude', runner)
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.segments.map((s) => s.text), ['hello'])
  })

  test('a segment with a low-confidence alt guess is kept (text unchanged), not dropped', async () => {
    const runner = fakeRunner({ ok: true, output: JSON.stringify([{ id: 0, text: 'so Jesus is', alt: 'so yeh cheez hai', note: 'hi' }]) })
    const result = await cleanupTranscript([seg('so Jesus is')], 'claude', runner)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.segments.length, 1)
      assert.equal(result.segments[0].text, 'so Jesus is')
      assert.equal(result.segments[0].alt, 'so yeh cheez hai')
      assert.equal(result.segments[0].note, 'hi')
    }
  })
})
