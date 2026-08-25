// desktop/engine-overrides/electron/notetaker/transcriptCleanup.ts
//
// Corrects STT errors in a meeting's raw transcript through the user's own
// headless Claude Code/Codex CLI (headlessAgent.ts) — 2026-08-25 spec §4.
//
// THE WHOLE SAFETY ARGUMENT FOR THIS FILE: the model is never asked to
// produce a timestamp, channel, or speaker — only corrected TEXT, keyed by
// an id we already control. parseCleanupOutput below splices corrected text
// back into our own original segment objects; every other field is copied
// through untouched, never read from the model's response. That's what
// makes "preserve every timestamp exactly" hold with zero hallucination
// surface — the risky operation (a model producing a number) simply never
// happens, because we never ask for one.

import { runHeadlessAgent, type HeadlessProvider } from './headlessAgent'
import type { TranscriptSegment } from './transcriptMerge'
import { createNotetakerLogger } from './notetakerLog'

const log = createNotetakerLogger('transcript-cleanup')

export const DEFAULT_CLEANUP_PROMPT =
  'You are cleaning up a raw speech-to-text transcript of a recorded meeting. ' +
  'You will receive a JSON array of {id, text} pairs, each one segment of speech, in order. ' +
  'Fix only clear transcription errors — misheard words, garbled phrases, obviously wrong homophones — ' +
  'using the surrounding segments as context. Do not summarize, shorten, rephrase for style, or change meaning. ' +
  'Do not merge, split, reorder, or drop any segment. ' +
  'Return a JSON array of {id, text} pairs, one per input id, in the same order, with only the text corrected.'

/** {id, text} only — channel/speaker/timestamps are deliberately never
 *  sent, since they're never meant to come back (see file header). */
export function buildCleanupInput(segments: TranscriptSegment[], prompt: string): string {
  const payload = segments.map((s, id) => ({ id, text: s.text }))
  return `${prompt}\n\n${JSON.stringify(payload)}`
}

type CleanupEntry = { id: unknown; text: unknown }

/**
 * Pure. Validates the model's response per-id, not as a monolithic
 * pass/fail: a missing id, a malformed entry, a duplicate id, or empty text
 * for a given id just means THAT segment falls back to its own original
 * text — never a reason to discard the rest of a meeting's cleanup.
 * First occurrence of a duplicate id wins; later ones for the same id are
 * ignored (an unexpected model response, not a reason to prefer the later
 * one over the first).
 */
export function parseCleanupOutput(raw: string, segments: TranscriptSegment[]): TranscriptSegment[] {
  const corrected = new Map<number, string>()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      for (const entry of parsed as CleanupEntry[]) {
        if (!entry || typeof entry !== 'object') continue
        const id = entry.id
        const text = entry.text
        if (typeof id !== 'number' || !Number.isInteger(id)) continue
        if (id < 0 || id >= segments.length) continue
        if (corrected.has(id)) continue // first occurrence wins
        if (typeof text !== 'string' || text.length === 0) continue
        corrected.set(id, text)
      }
    }
  } catch {
    // Unparseable response as a whole — every segment falls back below.
    // Not a thrown error: the caller (cleanupTranscript) is the one that
    // decides whether a fully-empty `corrected` map means the overall call
    // failed (raw itself never having been valid JSON) or just an
    // all-fallback success (some ids legitimately absent).
  }
  return segments.map((seg, id) => {
    const text = corrected.get(id)
    return text === undefined ? seg : { ...seg, text }
  })
}

export type CleanupResult =
  | { ok: true; segments: TranscriptSegment[] }
  | { ok: false; error: string }

/**
 * Orchestrates the cleanup call. `ok: false` only when the headless call
 * itself failed, or the response wasn't parseable as JSON AT ALL (spec §4:
 * "cleanup_status = 'failed' only if the call itself failed ... or the
 * response wasn't parseable as JSON at all") — a response that parsed but
 * left some ids uncorrected is still `ok: true`, those segments just kept
 * their original text via parseCleanupOutput's own per-id fallback.
 */
export async function cleanupTranscript(
  segments: TranscriptSegment[],
  provider: HeadlessProvider,
  promptOverride?: string | null,
  // Injected for testability — defaults to the real headless CLI call.
  // Same shape as NotetakerController's own injected-deps pattern rather
  // than mocking the module graph.
  runAgent: typeof runHeadlessAgent = runHeadlessAgent,
): Promise<CleanupResult> {
  const prompt = promptOverride ?? DEFAULT_CLEANUP_PROMPT
  const input = buildCleanupInput(segments, prompt)
  const result = await runAgent(provider, input)
  if (!result.ok) {
    log.error('cleanup call failed', { provider, error: result.error })
    return { ok: false, error: result.error }
  }
  try {
    JSON.parse(result.output)
  } catch {
    log.error('cleanup response was not parseable JSON at all', { provider, outputPreview: result.output.slice(0, 200) })
    return { ok: false, error: 'response was not valid JSON' }
  }
  const cleaned = parseCleanupOutput(result.output, segments)
  log.debug('cleanup completed', { provider, segmentCount: segments.length })
  return { ok: true, segments: cleaned }
}
