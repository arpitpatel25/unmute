// desktop/engine-overrides/electron/notetaker/transcriptCleanup.ts
//
// Corrects STT errors in a meeting's raw transcript through the user's own
// headless Claude Code/Codex CLI (headlessAgent.ts) — 2026-08-25 spec §4.
//
// THE WHOLE SAFETY ARGUMENT FOR THIS FILE: the model is never asked to
// produce a timestamp, channel, or speaker — only corrected TEXT (plus the
// optional alt/note pair below), keyed by an id we already control.
// parseCleanupOutput below splices the correction back into our own
// original segment objects; every other field is copied through untouched,
// never read from the model's response. That's what makes "preserve every
// timestamp exactly" hold with zero hallucination surface — the risky
// operation (a model producing a number) simply never happens, because we
// never ask for one.
//
// FULLY FIXED, NOT USER-EDITABLE (2026-08-26): unlike notesSummary.ts, this
// prompt has no user-customizable seam at all — Settings offers no cleanup
// override. The correction rules below (language recovery, hallucination
// handling, the output contract this file's own parser depends on) are
// judgment calls we want to hold constant for every meeting, not something
// a per-user prompt edit should be able to loosen.

import { runHeadlessAgent, type HeadlessProvider } from './headlessAgent'
import { timeoutMsForSegments } from './pipelineTimeout'
import type { TranscriptSegment } from './transcriptMerge'
import { createNotetakerLogger } from './notetakerLog'
import { extractJson } from './extractJson'

const log = createNotetakerLogger('transcript-cleanup')

const FIXED_CLEANUP_PROMPT =
  'You are cleaning up a raw speech-to-text transcript of a recorded meeting. ' +
  'You will receive a JSON array of {id, text} pairs, each one segment of speech, in order.\n\n' +

  'Fix only clear transcription errors — misheard words, garbled phrases, obviously wrong homophones — ' +
  'using the surrounding segments as context. Do not summarize, shorten, rephrase for style, or change meaning. ' +
  'Do not merge, split, or reorder any segment.\n\n' +

  'LANGUAGE AND CODE-SWITCHING\n\n' +
  'The speaker may switch between languages mid-sentence. The speech-to-text engine may have been locked to a ' +
  'single output language, so speech in another language is sometimes forced into words of that output language ' +
  'that are grammatically valid but semantically incoherent in context.\n\n' +
  'When a segment reads as fluent text in the output language yet makes no sense given the surrounding segments, ' +
  'consider that it may be mis-decoded speech from another language. Use phonetic similarity to the transcribed ' +
  'text plus the surrounding discussion to recover what was actually said.\n\n' +
  'Rules for such segments:\n' +
  '- Write recovered words in Latin script, romanized phonetically. Never output non-Latin scripts, even if the ' +
  'input already contains them — romanize those too.\n' +
  '- Transliterate; do not translate. Preserve the speaker\'s original words as spoken, not their meaning in the ' +
  'output language.\n' +
  '- Leave the rest of the segment untouched. Mixed-language segments stay mixed.\n' +
  '- Only recover where phonetic and contextual evidence agree. If a segment is unintelligible, leave its ' +
  'original text unchanged rather than guessing.\n\n' +

  'HALLUCINATED SEGMENTS\n\n' +
  'Some segments come from an audio channel that had no real speech in it — total silence or background noise — ' +
  'and the speech-to-text engine hallucinated a short generic line instead of returning nothing. If a segment\'s ' +
  'ENTIRE text is one of these invented lines (for example "Thank you.", "Thanks for watching.", "Please ' +
  'subscribe.", "Bye.", "See you next time.", a bare "Hmm." or "Okay.", or a nonsense loop like the same word ' +
  'repeated many times) and it does not fit as a real reply to what is being said around it, set that segment\'s ' +
  '`text` to an empty string instead of correcting it. Only do this when you are confident it is invented, not ' +
  'real speech — a short but plausible real reply must be left exactly as is. When unsure, leave the text ' +
  'unchanged.\n\n' +

  'OUTPUT\n\n' +
  'Return a JSON array of {id, text, alt, note} objects, one per input id, in the same order. ' +
  'Put a high-confidence correction directly in `text`. When you suspect mis-decoded speech from another ' +
  'language but cannot recover it with confidence, leave `text` unchanged, put your best guess at the recovered ' +
  'words in `alt`, and name the suspected language in `note`. For a confirmed hallucination, set `text` to "". ' +
  'Use an empty string for `alt`/`note` when there is nothing to add — every object must include all four keys. ' +
  'Output ONLY that JSON array — no markdown code fence, no explanation, no other text before or after it.'

/** {id, text} only — channel/speaker/timestamps are deliberately never
 *  sent, since they're never meant to come back (see file header). No
 *  instructions parameter: the whole prompt is fixed. */
export function buildCleanupInput(segments: TranscriptSegment[]): string {
  const payload = segments.map((s, id) => ({ id, text: s.text }))
  return `${FIXED_CLEANUP_PROMPT}\n\n${JSON.stringify(payload)}`
}

type CleanupEntry = { id: unknown; text: unknown; alt?: unknown; note?: unknown }
type CleanupCorrection = { text: string; alt?: string; note?: string }

/**
 * Pure. Validates the model's response per-id, not as a monolithic
 * pass/fail: a missing id, a malformed entry, or a duplicate id just means
 * THAT segment falls back to its own original text — never a reason to
 * discard the rest of a meeting's cleanup. First occurrence of a duplicate
 * id wins; later ones for the same id are ignored (an unexpected model
 * response, not a reason to prefer the later one over the first).
 *
 * An empty `text` IS a valid, intentional correction (not a fallback
 * trigger) — the prompt's hallucination rule tells the model to empty a
 * segment it's confident is pure STT invention on silence, and
 * cleanupTranscript below drops those from the final result entirely.
 *
 * `alt`/`note` are only applied when non-empty strings — most segments get
 * neither, and a segment's original object never carries the two keys at
 * all unless cleanup actually set them (see transcriptMerge.ts's own note
 * on TranscriptSegment).
 */
export function parseCleanupOutput(raw: string, segments: TranscriptSegment[]): TranscriptSegment[] {
  const corrected = new Map<number, CleanupCorrection>()
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
      const correction: CleanupCorrection = { text }
      if (typeof entry.alt === 'string' && entry.alt.length > 0) correction.alt = entry.alt
      if (typeof entry.note === 'string' && entry.note.length > 0) correction.note = entry.note
      corrected.set(id, correction)
    }
  }
  // else: nothing extractable at all — every segment falls back below.
  // The caller (cleanupTranscript) is the one that decides whether a fully-
  // empty `corrected` map means the overall call failed (nothing
  // extractable) or just an all-fallback success (some ids legitimately
  // absent from an otherwise-valid response).
  return segments.map((seg, id) => {
    const correction = corrected.get(id)
    if (!correction) return seg
    const next: TranscriptSegment = { ...seg, text: correction.text }
    if (correction.alt !== undefined) next.alt = correction.alt
    if (correction.note !== undefined) next.note = correction.note
    return next
  })
}

export type CleanupResult =
  | { ok: true; segments: TranscriptSegment[] }
  | { ok: false; error: string }

/** Cleanup runs on the user's own connected CLI agent only — see
 *  notesSummary.ts's NoteProvider for why a managed cloud model is not an
 *  option here. */
export type CleanupProvider = HeadlessProvider

type CleanupRunner = (
  provider: CleanupProvider,
  input: string,
  timeoutMs?: number,
) => Promise<{ ok: true; output: string } | { ok: false; error: string }>

async function runCleanupAgent(
  provider: CleanupProvider,
  input: string,
  timeoutMs?: number,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  return runHeadlessAgent(provider, input, timeoutMs === undefined ? {} : { timeoutMs })
}

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
  provider: CleanupProvider,
  // Injected for testability — defaults to the real headless CLI call.
  // Same shape as NotetakerController's own injected-deps pattern rather
  // than mocking the module graph.
  runAgent: CleanupRunner = runCleanupAgent,
): Promise<CleanupResult> {
  const input = buildCleanupInput(segments)
  // A 9h meeting's 286 segments were still being cleaned when the flat 300s
  // budget killed the stage (2026-09-09). Scale it with the transcript.
  const result = await runAgent(provider, input, timeoutMsForSegments(segments.length))
  if (!result.ok) {
    log.error('cleanup call failed', { provider, error: result.error })
    return { ok: false, error: result.error }
  }
  if (!Array.isArray(extractJson(result.output, 'array'))) {
    log.error('cleanup response was not parseable JSON at all', { provider, outputPreview: result.output.slice(0, 200) })
    return { ok: false, error: 'response was not valid JSON' }
  }
  // A segment the model confidently emptied (the hallucination rule above)
  // is dropped here, not kept as a blank line — same "empty means gone"
  // convention mergeChannelChunks already uses for the raw capture-time
  // filter.
  const cleaned = parseCleanupOutput(result.output, segments).filter((s) => s.text.trim().length > 0)
  log.debug('cleanup completed', { provider, segmentCount: segments.length, keptCount: cleaned.length })
  return { ok: true, segments: cleaned }
}
