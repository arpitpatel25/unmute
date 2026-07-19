// correctionGate — per-edit acceptance for LLM speech-to-text corrections.
//
// DESIGN (settled with the user, 2026-07-16): in noisy environments Whisper
// mishears words ("world wall tree" for "worktree"). An LLM given the whole
// transcript can often recover the intended words — but an unconstrained
// LLM corrects toward PLAUSIBILITY, not intent, and on garbled input it
// invents fluent text the user never said. So: the LLM only PROPOSES.
// This gate diffs the proposal against the raw transcript and judges each
// edit individually:
//   * substitutions  — accepted only if the replacement SOUNDS like what it
//     replaces (STT errors are sound-alikes; meaning-changes are not)
//   * deletions      — accepted only if small (fillers/stutters), never a clause
//   * insertions     — always rejected (new content cannot come from noise)
//   * numbers and negations — locked (a not→now flip passes phonetics but
//     inverts meaning; the stakes dwarf the win)
//   * global budget  — too many edits ⇒ the raw transcript wholesale
// One overreaching edit no longer poisons the good ones: partial acceptance.
// Pure module: no electron imports — unit-tested by correctionGate.test.ts.

export interface GatedCorrection {
  text: string
  acceptedEdits: number
  rejectedEdits: number
}

const NEGATIONS = new Set(['no', 'not', 'never', 'none', 'nor', "don't", "can't", "won't", "isn't", "aren't", "didn't", "doesn't", "shouldn't", "couldn't", "wouldn't"])
const FILLERS = new Set(['uh', 'um', 'erm', 'uhm', 'hmm'])
/** A deletion hunk larger than this many words is a clause, not a filler. */
const MAX_DELETION_WORDS = 3
/** Substitution accepted at or above this phonetic/char similarity. */
const MIN_SIMILARITY = 0.5
/** Stricter bar when a number or negation is involved. */
const LOCKED_SIMILARITY = 0.95
/** Spelling propagation: a below-bar substitution is accepted ONLY when the
 *  replacement already appears elsewhere in the raw transcript (the user's own
 *  ground-truth spelling — e.g. they spelled a name out once) AND it still
 *  sounds at least this related to what it replaces. The "appears elsewhere"
 *  proof is the safety: the model can normalize to a spelling the user produced
 *  but can never invent one; this sound floor blocks swapping one distinct term
 *  for an unrelated one that merely happens to appear elsewhere. */
const SPELLING_SIMILARITY = 0.34
/** Only propagate distinctive terms (names/products/tech words), never short
 *  common words where an "appears elsewhere" match would be coincidental. */
const MIN_PROPAGATION_LEN = 4
/** If more than this fraction of raw words sit in changed hunks, distrust
 *  the whole proposal (the model rewrote, not corrected). Deliberately
 *  loose: the per-edit gate is the real defense — this only catches the
 *  degenerate everything-rewritten case where diff alignment itself is
 *  meaningless. */
const MAX_CHANGED_FRACTION = 0.8

interface Token { norm: string; surface: string }

function tokenize(text: string): Token[] {
  const out: Token[] = []
  for (const surface of text.split(/\s+/)) {
    if (!surface) continue
    const norm = surface.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')
    if (norm) out.push({ norm, surface })
  }
  return out
}

/** Simplified metaphone-style key: leading vowel kept, others dropped,
 *  common digraphs collapsed, doubles deduped. Good enough to rank
 *  sound-alikes above meaning-changes; exactness is not the goal. */
export function phoneticKey(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!w) return ''
  if (/^\d+$/.test(w)) return w // numbers are their own key
  w = w
    .replace(/ph/g, 'f')
    .replace(/gh/g, 'g')
    .replace(/ck/g, 'k')
    .replace(/sh/g, 'x')
    .replace(/ch/g, 'x')
    .replace(/th/g, 't')
    .replace(/wr/g, 'r')
    .replace(/wh/g, 'w')
    .replace(/qu/g, 'k')
    .replace(/c/g, 'k')
    .replace(/z/g, 's')
  const head = w[0]
  const tail = w.slice(1).replace(/[aeiouy]/g, '')
  let key = head + tail
  key = key.replace(/(.)\1+/g, '$1')
  return key
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

function similarity(a: string, b: string): number {
  if (!a && !b) return 1
  const max = Math.max(a.length, b.length)
  if (max === 0) return 1
  return 1 - levenshtein(a, b) / max
}

/** Similarity of two word segments: best of phonetic-key similarity and
 *  raw character similarity, computed on the concatenated segments (so
 *  "world wall tree" vs "worktree" compares as wholes). */
export function segmentSimilarity(a: string, b: string): number {
  const normA = a.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const normB = b.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const phonA = a.toLowerCase().split(/\s+/).filter(Boolean).map(phoneticKey).join('')
  const phonB = b.toLowerCase().split(/\s+/).filter(Boolean).map(phoneticKey).join('')
  return Math.max(similarity(normA, normB), similarity(phonA, phonB))
}

interface Hunk { rawTokens: Token[]; propTokens: Token[] }

/** LCS-based word diff → list of alternating equal/changed hunks. */
function diffHunks(raw: Token[], prop: Token[]): Array<{ equal: boolean } & Hunk> {
  const m = raw.length, n = prop.length
  // LCS table (word-normalized)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = raw[i].norm === prop[j].norm ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const hunks: Array<{ equal: boolean } & Hunk> = []
  let i = 0, j = 0
  const push = (equal: boolean, rt: Token[], pt: Token[]) => {
    const last = hunks[hunks.length - 1]
    if (last && last.equal === equal) { last.rawTokens.push(...rt); last.propTokens.push(...pt) }
    else hunks.push({ equal, rawTokens: [...rt], propTokens: [...pt] })
  }
  while (i < m && j < n) {
    if (raw[i].norm === prop[j].norm) { push(true, [raw[i]], [prop[j]]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push(false, [raw[i]], []); i++ }
    else { push(false, [], [prop[j]]); j++ }
  }
  if (i < m) push(false, raw.slice(i), [])
  if (j < n) push(false, [], prop.slice(j))
  return hunks
}

function containsLocked(tokens: Token[]): boolean {
  return tokens.some((t) => /\d/.test(t.norm) || NEGATIONS.has(t.norm))
}

/** Is this substitution a safe spelling-propagation? (see SPELLING_SIMILARITY) */
function isSpellingPropagation(h: { equal: boolean } & Hunk, rawNormSet: Set<string>, sim: number): boolean {
  if (containsLocked(h.rawTokens) || containsLocked(h.propTokens)) return false // numbers/negations stay locked
  if (sim < SPELLING_SIMILARITY) return false // must still sound related — not an arbitrary term swap
  // Every proposed word is a distinctive term the user produced ELSEWHERE in
  // the transcript. (In a substitution hunk the raw side differs from the
  // proposal, so a norm found in rawNormSet necessarily came from another hunk.)
  return h.propTokens.length > 0 && h.propTokens.every(
    (t) => t.norm.length >= MIN_PROPAGATION_LEN && rawNormSet.has(t.norm),
  )
}

function isFillerDeletion(tokens: Token[]): boolean {
  if (tokens.length === 0 || tokens.length > MAX_DELETION_WORDS) return false
  // Pure fillers, or a short stutter run (all words repeat within the hunk
  // or match an adjacent kept word is too complex — accept short hunks made
  // of fillers/duplicated words only).
  const seen = new Set<string>()
  for (const t of tokens) {
    if (FILLERS.has(t.norm)) continue
    if (seen.has(t.norm)) continue
    seen.add(t.norm)
  }
  // A hunk qualifies when every word is a filler or a repeat inside the hunk.
  return tokens.every((t) => FILLERS.has(t.norm)) || tokens.length <= MAX_DELETION_WORDS && tokens.every((t, idx) => FILLERS.has(t.norm) || tokens.findIndex(o => o.norm === t.norm) < idx || FILLERS.has(t.norm)) && tokens.some((t) => FILLERS.has(t.norm))
}

export function applyGatedCorrection(raw: string, proposed: string | null): GatedCorrection {
  const asRaw = (rejected: number): GatedCorrection => ({ text: raw, acceptedEdits: 0, rejectedEdits: rejected })
  if (!proposed) return asRaw(0)
  const p = proposed.trim()
  if (!p) return asRaw(0)

  const rawTokens = tokenize(raw)
  const propTokens = tokenize(p)
  if (rawTokens.length === 0) return asRaw(0)
  // Every spelling the user actually produced — the only spellings we let the
  // model propagate to other (misheard) occurrences of the same term.
  const rawNormSet = new Set(rawTokens.map((t) => t.norm))

  const hunks = diffHunks(rawTokens, propTokens)

  // Global sanity: how much of the raw text sits inside changed hunks?
  const changedRawWords = hunks.filter((h) => !h.equal).reduce((a, h) => a + h.rawTokens.length, 0)
  const changedPropWords = hunks.filter((h) => !h.equal).reduce((a, h) => a + h.propTokens.length, 0)
  if (Math.max(changedRawWords, changedPropWords) / rawTokens.length > MAX_CHANGED_FRACTION) {
    return asRaw(hunks.filter((h) => !h.equal).length)
  }

  const parts: string[] = []
  let accepted = 0
  let rejected = 0
  for (const h of hunks) {
    if (h.equal) {
      // Same words — take the proposal's surface (it may carry better
      // punctuation/casing; the words themselves are identical).
      parts.push(h.propTokens.map((t) => t.surface).join(' '))
      continue
    }
    const rawSeg = h.rawTokens.map((t) => t.surface).join(' ')
    const propSeg = h.propTokens.map((t) => t.surface).join(' ')
    if (h.rawTokens.length === 0) {
      // Pure insertion — new content never comes from noise. Reject.
      rejected++
      continue
    }
    if (h.propTokens.length === 0) {
      // Deletion — only fillers/stutter-scale removals allowed.
      if (isFillerDeletion(h.rawTokens)) { accepted++ } else { rejected++; parts.push(rawSeg) }
      continue
    }
    // Substitution — phonetic gate, with a stricter bar around numbers/negations.
    const bar = containsLocked(h.rawTokens) || containsLocked(h.propTokens) ? LOCKED_SIMILARITY : MIN_SIMILARITY
    const sim = segmentSimilarity(
      h.rawTokens.map((t) => t.norm).join(' '),
      h.propTokens.map((t) => t.norm).join(' '),
    )
    if (sim >= bar) { parts.push(propSeg); accepted++ }
    else if (isSpellingPropagation(h, rawNormSet, sim)) { parts.push(propSeg); accepted++ } // normalize to the user's own spelling
    else { parts.push(rawSeg); rejected++ }
  }

  const text = parts.join(' ').replace(/\s+/g, ' ').trim()
  return { text, acceptedEdits: accepted, rejectedEdits: rejected }
}
