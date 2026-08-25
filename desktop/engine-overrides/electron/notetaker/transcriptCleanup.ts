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
//
// PROMPT IS TWO PARTS (2026-08-26): FIXED_CLEANUP_PREAMBLE/FIXED_CLEANUP_
// CONTRACT bookend whatever instructions text is in play (the user's own
// override, or DEFAULT_CLEANUP_INSTRUCTIONS) and are never shown in — or
// editable from — Settings. They carry the I/O contract this file's own
// parser depends on (the {id,text} shape, no markdown fence) and the
// hallucination-clearing rule below, so both hold regardless of whatever
// the user has customized the "how to correct text" instructions to say.
// Only the middle instructions text is ever persisted as a user override.

import { runHeadlessAgent, type HeadlessProvider } from './headlessAgent'
import type { TranscriptSegment } from './transcriptMerge'
import { createNotetakerLogger } from './notetakerLog'
import { extractJson } from './extractJson'

const log = createNotetakerLogger('transcript-cleanup')

const FIXED_CLEANUP_PREAMBLE =
  'You are cleaning up a raw speech-to-text transcript of a recorded meeting. ' +
  'You will receive a JSON array of {id, text} pairs, each one segment of speech, in order.'

export const DEFAULT_CLEANUP_INSTRUCTIONS =
  'Fix only clear transcription errors — misheard words, garbled phrases, obviously wrong homophones — ' +
  'using the surrounding segments as context. Do not summarize, shorten, rephrase for style, or change meaning.'

const FIXED_CLEANUP_CONTRACT =
  'Do not merge, split, or reorder any segment. ' +
  'Some segments come from an audio channel that had no real speech in it — total silence or background noise — ' +
  'and the speech-to-text engine hallucinated a short generic line instead of returning nothing. ' +
  'If a segment\'s ENTIRE text is one of these invented lines (for example "Thank you.", "Thanks for watching.", ' +
  '"Please subscribe.", "Bye.", "See you next time.", a bare "Hmm." or "Okay.", or a nonsense loop like the same ' +
  'word repeated many times) and it does not fit as a real reply to what is being said around it, return an empty ' +
  'string "" for that segment\'s text instead of correcting it. Only do this when you are confident it is invented, ' +
  'not real speech — a short but plausible real reply must be left exactly as is. When unsure, leave the text unchanged. ' +
  'Return a JSON array of {id, text} pairs, one per input id, in the same order, with only the text corrected or, ' +
  'for a confirmed hallucination, emptied. ' +
  'Output ONLY that JSON array — no markdown code fence, no explanation, no other text before or after it.'

/** {id, text} only — channel/speaker/timestamps are deliberately never
 *  sent, since they're never meant to come back (see file header).
 *  `instructions` is the editable middle third; the fixed preamble and
 *  contract always bookend it, whatever it says. */
export function buildCleanupInput(segments: TranscriptSegment[], instructions: string): string {
  const payload = segments.map((s, id) => ({ id, text: s.text }))
  return `${FIXED_CLEANUP_PREAMBLE}\n\n${instructions}\n\n${FIXED_CLEANUP_CONTRACT}\n\n${JSON.stringify(payload)}`
}

type CleanupEntry = { id: unknown; text: unknown }

/**
 * Pure. Validates the model's response per-id, not as a monolithic
 * pass/fail: a missing id, a malformed entry, or a duplicate id just means
 * THAT segment falls back to its own original text — never a reason to
 * discard the rest of a meeting's cleanup. First occurrence of a duplicate
 * id wins; later ones for the same id are ignored (an unexpected model
 * response, not a reason to prefer the later one over the first).
 *
 * An empty string IS a valid, intentional correction (not a fallback
 * trigger) — FIXED_CLEANUP_CONTRACT tells the model to return "" for a
 * segment it's confident is pure STT hallucination on silence, and
 * cleanupTranscript below drops those from the final result entirely.
 */
export function parseCleanupOutput(raw: string, segments: TranscriptSegment[]): TranscriptSegment[] {
  const corrected = new Map<number, string>()
  // extractJson handles the real, live-observed shape: Claude Code's -p
  // mode commonly wraps its answer in a ```json fence even when told not
  // to — a bare JSON.parse(raw) rejected that outright and was the actual
  // cause of cleanup failing every time, not a real CLI/model problem.
  const parsed = extractJson(raw, 'array')
  if (Array.isArray(parsed)) {
    for (const entry of parsed as CleanupEntry[]) {
      if (!entry || typeof entry !== 'object') continue
      const id = entry.id
      const text = entry.text
      if (typeof id !== 'number' || !Number.isInteger(id)) continue
      if (id < 0 || id >= segments.length) continue
      if (corrected.has(id)) continue // first occurrence wins
      if (typeof text !== 'string') continue
      corrected.set(id, text)
    }
  }
  // else: nothing extractable at all — every segment falls back below.
  // The caller (cleanupTranscript) is the one that decides whether a fully-
  // empty `corrected` map means the overall call failed (nothing
  // extractable) or just an all-fallback success (some ids legitimately
  // absent from an otherwise-valid response).
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
 *
 * `instructionsOverride` is the user's editable middle-third override, if
 * any — never the full prompt. buildCleanupInput always wraps it in the
 * fixed preamble/contract regardless.
 */
export async function cleanupTranscript(
  segments: TranscriptSegment[],
  provider: HeadlessProvider,
  instructionsOverride?: string | null,
  // Injected for testability — defaults to the real headless CLI call.
  // Same shape as NotetakerController's own injected-deps pattern rather
  // than mocking the module graph.
  runAgent: typeof runHeadlessAgent = runHeadlessAgent,
): Promise<CleanupResult> {
  const instructions = instructionsOverride ?? DEFAULT_CLEANUP_INSTRUCTIONS
  const input = buildCleanupInput(segments, instructions)
  const result = await runAgent(provider, input)
  if (!result.ok) {
    log.error('cleanup call failed', { provider, error: result.error })
    return { ok: false, error: result.error }
  }
  if (!Array.isArray(extractJson(result.output, 'array'))) {
    log.error('cleanup response was not parseable JSON at all', { provider, outputPreview: result.output.slice(0, 200) })
    return { ok: false, error: 'response was not valid JSON' }
  }
  // A segment the model confidently emptied (FIXED_CLEANUP_CONTRACT's
  // hallucination-clearing rule) is dropped here, not kept as a blank line
  // — same "empty means gone" convention mergeChannelChunks already uses
  // for the raw capture-time filter.
  const cleaned = parseCleanupOutput(result.output, segments).filter((s) => s.text.trim().length > 0)
  log.debug('cleanup completed', { provider, segmentCount: segments.length, keptCount: cleaned.length })
  return { ok: true, segments: cleaned }
}
