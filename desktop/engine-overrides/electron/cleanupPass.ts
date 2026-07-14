// cleanupPass — the polish layer between raw STT text and the paste.
//
// WHY (2026-07-15 decision): our pipeline pastes verbatim STT output —
// "Uh so so I I want you to create creator..." — while competitors run a
// fast LLM pass that drops fillers and stutter-duplicates. Half the
// perceived accuracy gap is this polish. Rules are deliberately narrow:
// remove disfluencies, fix nothing else, never add content. Every guard
// fails OPEN to the raw transcript — a bad cleanup must never eat words.
// Pure module: unit-tested by cleanupPass.test.ts. The LLM call itself
// lives in sessionManager (tryManagedLLM) with a hard timeout.

export const CLEANUP_TIMEOUT_MS = 900
const MIN_RAW_CHARS = 40
const MIN_RATIO = 0.4
const MAX_RATIO = 1.4

const REFUSAL_RE = /(i('m| am) sorry.{0,20}(can't|cannot)|i (can't|cannot) (help|assist|process)|as an ai|against my (guidelines|policy))/i

const SYSTEM_PROMPT = [
  'You clean up raw speech-to-text dictation. Apply ONLY these edits:',
  '1. Remove filler words (uh, um, like when used as filler).',
  '2. Collapse stutter repeats ("so so", "I I", "the the" → one).',
  '3. Remove false starts the speaker abandoned mid-phrase.',
  'Rules: NEVER add words, facts, or content that is not in the input.',
  'Do not rephrase, summarize, or change meaning, tone, or language.',
  'Keep slang, profanity, and technical terms exactly as spoken.',
  'Return ONLY the cleaned text — no quotes, no commentary.',
].join(' ')

export function shouldAttemptCleanup(raw: string): boolean {
  return raw.trim().length >= MIN_RAW_CHARS
}

export function buildCleanupMessages(raw: string): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: raw },
  ]
}

export function acceptCleanupResult(raw: string, cleaned: string | null): string {
  if (!cleaned) return raw
  const c = cleaned.trim()
  if (!c) return raw
  if (REFUSAL_RE.test(c)) return raw
  const ratio = c.length / Math.max(1, raw.trim().length)
  if (ratio < MIN_RATIO || ratio > MAX_RATIO) return raw
  return c
}
