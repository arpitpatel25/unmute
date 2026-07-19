// cleanupPass — the polish layer between raw STT text and the paste.
//
// WHY (2026-07-15 decision): our pipeline pastes verbatim STT output —
// "Uh so so I I want you to create creator..." — while competitors run a
// fast LLM pass that drops fillers and stutter-duplicates. Half the
// perceived accuracy gap is this polish. Rules are deliberately narrow:
// remove disfluencies, fix nothing else, never add content. Every guard
// fails OPEN to the raw transcript — a bad cleanup must never eat words.
//
// FIELD INCIDENT (2026-07-15, first test day): the LLM crossed from
// "remove fillers" into SUMMARIZING — it deleted whole questions and the
// user's trailing instruction (290→168 chars) while passing the old
// char-ratio guard. Lesson: verbatim preservation must be enforced
// STRUCTURALLY, not by prompt. acceptCleanupResult now requires the
// cleaned text to be a pure DELETION of the raw text (kept words appear
// in the same order — any rewording/reordering/insertion is rejected)
// and caps the deletion at MAX_WORD_REMOVAL of the raw words.
//
// Pure module: unit-tested by cleanupPass.test.ts. The LLM call itself
// lives in sessionManager (tryManagedLLM) with a hard timeout.

export const CLEANUP_TIMEOUT_MS = 900
// Model history (field-tested): Scout summarized a dictation (2026-07-15)
// → tried gpt-oss-120b on GROQ → timed out on 4/5 real calls (900ms budget)
// → back to Scout (2026-07-16) → 2026-07-18: Groq DEPRECATED Scout, so every
// call 404'd. Moved /v1/llm to CEREBRAS, whose gpt-oss-120b returns in ~0.6s
// (full round-trip) — fast enough for the noisy-path CORRECTION_TIMEOUT_MS
// (1500ms) budget, with strong quality. This model name is sent to the worker
// and MUST be a valid Cerebras model, or it 404s (the exact Scout failure).
export const CLEANUP_MODEL = 'gpt-oss-120b'
const MIN_RAW_CHARS = 40
/** Cleaned text must keep at least this fraction of the raw WORDS.
 *  Heavy stutter legitimately removes ~25-35%; summarization removes more. */
const MIN_WORD_KEEP_RATIO = 0.7

const REFUSAL_RE = /(i('m| am) sorry.{0,20}(can't|cannot)|i (can't|cannot) (help|assist|process)|as an ai|against my (guidelines|policy))/i

/** Meaning-inversion lock (mirrors correctionGate.NEGATIONS): deleting one of
 *  these — or a number — flips what was said, the one thing cleanup must never
 *  do. Even a deletion-only edit can invert meaning ("do not send" → "do
 *  send"), so the deletion-only guard is not enough on its own. */
const CLEANUP_NEGATIONS = new Set(['no', 'not', 'never', 'none', 'nor', "don't", "can't", "won't", "isn't", "aren't", "didn't", "doesn't", "shouldn't", "couldn't", "wouldn't"])

function isLockedWord(w: string): boolean {
  return /\d/.test(w) || CLEANUP_NEGATIONS.has(w)
}

/** True iff the cleaned text dropped any negation/number that the raw contained
 *  (compares per-token occurrence counts of locked words). */
function droppedLockedWord(rawWords: string[], cleanedWords: string[]): boolean {
  const cleanedCounts = new Map<string, number>()
  for (const w of cleanedWords) if (isLockedWord(w)) cleanedCounts.set(w, (cleanedCounts.get(w) ?? 0) + 1)
  const rawCounts = new Map<string, number>()
  for (const w of rawWords) if (isLockedWord(w)) rawCounts.set(w, (rawCounts.get(w) ?? 0) + 1)
  for (const [w, n] of rawCounts) if ((cleanedCounts.get(w) ?? 0) < n) return true
  return false
}

const SYSTEM_PROMPT = [
  'You clean up raw speech-to-text dictation. Apply ONLY these edits:',
  '1. Remove filler words and discourse fillers (uh, um, like, yeah, you know,',
  '   I mean, sort of, kind of, basically, actually) when used as filler.',
  '2. Collapse stutter repeats ("so so", "I I", "the the" → one).',
  '3. Remove abandoned false starts the speaker dropped mid-phrase.',
  'Rules: you may ONLY DELETE words — never add, replace, reorder, or',
  'rephrase. Every word you keep must appear exactly as in the input.',
  'NEVER delete a meaningful/content word and NEVER change the meaning:',
  'delete ONLY genuine filler/discourse words, stutters, and abandoned',
  'false-starts. When in doubt, keep the word.',
  'Keep questions, instructions, and trailing sentences — they are',
  'content, not filler. Do not summarize. Never change numbers or',
  'negations. Keep slang, profanity, and technical terms exactly as spoken.',
  'Return ONLY the cleaned text — no quotes, no commentary.',
].join(' ')

// ─── Noisy-environment CORRECTION prompt (2026-07-16) ─────────────────
// Runs ONLY when the capture was flagged noisy. Unlike cleanup, correction
// may REPLACE misheard words — every proposed edit is then individually
// accepted/rejected by correctionGate (phonetic similarity, locked
// numbers/negations, no insertions). The prompt aims the model; the gate
// enforces the contract.
export const CORRECTION_TIMEOUT_MS = 1500

const CORRECTION_PROMPT = [
  'You fix speech-to-text transcription errors. The text below was dictated',
  'in a NOISY environment, so some words were misheard as similar-sounding',
  'wrong words. Using the context of the whole transcript, replace ONLY',
  'words that were plausibly misheard — every replacement must sound like',
  'what it replaces. You may also remove filler words and discourse fillers',
  '(uh, um, like, yeah, you know, I mean, sort of, kind of, basically,',
  'actually) and stutter repeats and abandoned false starts. But NEVER',
  'delete a meaningful/content word and NEVER change the meaning — delete',
  'only genuine filler, stutters, and abandoned false-starts; when in doubt,',
  'keep the word.',
  // Spelling propagation: users spell a name/product/technical term out loud
  // to force its spelling. STT gets it right where they spelled it but mishears
  // it elsewhere — so the same term ends up spelled several ways.
  'SPELLING: if a distinctive term (a name, product, or technical word) appears',
  'spelled out, hyphenated letter-by-letter (e.g. "C-A-L-O-R-I-F-Y"), or in ALL',
  'CAPS, treat that as the user\'s intended spelling and apply it to EVERY',
  'occurrence of that term in the transcript. Only normalize to a spelling that',
  'ALREADY appears somewhere in this transcript — never invent one.',
  'NEVER add new information, never rephrase passages that already',
  'make sense, never summarize, never change numbers or negations.',
  'Return ONLY the corrected text — no quotes, no commentary.',
].join(' ')

export function buildCorrectionMessages(raw: string): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: CORRECTION_PROMPT },
    { role: 'user', content: raw },
  ]
}

export function shouldAttemptCleanup(raw: string): boolean {
  return raw.trim().length >= MIN_RAW_CHARS
}

export function buildCleanupMessages(raw: string): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: raw },
  ]
}

/** Normalize to comparable word tokens: lowercase, punctuation stripped. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** True iff `kept` is an ordered subsequence of `original` — i.e. the
 *  cleaned text can be produced from the raw text by deletion alone. */
export function isDeletionOnly(original: string[], kept: string[]): boolean {
  let i = 0
  for (const w of kept) {
    while (i < original.length && original[i] !== w) i++
    if (i >= original.length) return false
    i++
  }
  return true
}

export interface CleanupVerdict {
  text: string
  accepted: boolean
  /** Why the LLM output was rejected ('' when accepted) — telemetry food. */
  reason: '' | 'empty' | 'refusal' | 'over-deletion' | 'grew' | 'reworded' | 'meaning-lock'
}

export function evaluateCleanup(raw: string, cleaned: string | null): CleanupVerdict {
  const reject = (reason: CleanupVerdict['reason']): CleanupVerdict => ({ text: raw, accepted: false, reason })
  if (!cleaned) return reject('empty')
  const c = cleaned.trim()
  if (!c) return reject('empty')
  if (REFUSAL_RE.test(c)) return reject('refusal')
  const rawWords = words(raw)
  const cleanedWords = words(c)
  if (rawWords.length === 0) return reject('empty')
  // Structural verbatim guard: deletion-only, bounded deletion.
  if (cleanedWords.length / rawWords.length < MIN_WORD_KEEP_RATIO) return reject('over-deletion')
  if (cleanedWords.length > rawWords.length) return reject('grew')
  if (!isDeletionOnly(rawWords, cleanedWords)) return reject('reworded')
  // Meaning lock: a deletion-only edit can still invert meaning by dropping a
  // negation or number ("do not send" → "do send"). Never allow it.
  if (droppedLockedWord(rawWords, cleanedWords)) return reject('meaning-lock')
  return { text: c, accepted: true, reason: '' }
}

export function acceptCleanupResult(raw: string, cleaned: string | null): string {
  return evaluateCleanup(raw, cleaned).text
}
