/**
 * A card title for the seconds before the real one arrives.
 *
 * With deferred naming the task is dispatched on the gating decision alone, so
 * for a moment there is a live card and no name. Falling back to the raw
 * utterance is what "unrouted" already looks like on the wall ("So there was
 * this idea that came to my mind abo…"), so the gap needs something that reads
 * as a title rather than as a failure.
 *
 * NO MODEL. Anything that costs a call would put the wait straight back.
 * This is deliberately dumb: drop the leading politeness and the command verb,
 * keep the first few content words, title-case the result. It is wrong often
 * enough that it must never persist — the real name replaces it within seconds
 * — but it is a plausible-looking placeholder rather than a transcript dump.
 */

/** Openers people speak before saying what they actually want. */
// The trailing separator is `\s+|$` rather than a literal space so an utterance
// that is ONLY preamble ("please") strips to nothing and falls to "New task",
// instead of titling the card "Please".
const PREAMBLE = /^(?:(?:hey|ok|okay|so|um|uh|please|can you|could you|i want to|i need to|i'd like to|let's|lets|go ahead and)(?:\s+|$))+/i

/** Leading verbs that name the ACTION, never the subject. Subject-led titles
 *  are the whole naming convention, so the placeholder honours it too. */
const LEAD_VERB = /^(?:(?:help me(?:\s+with|\s+to)?|plan(?:\s+out)?|draft|write|create|make|build|fix|check|look\s+(?:at|into)|find|open|read|review|update|add|start|set\s+up|summari[sz]e|tell\s+me\s+about|work\s+on)(?:\s+|$))+/i

const STOP = new Set(['a', 'an', 'the', 'for', 'to', 'of', 'my', 'our', 'some', 'and', 'in', 'on', 'about', 'with'])

export function provisionalName(utterance: string, maxWords = 4): string {
  const cleaned = (utterance || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(PREAMBLE, '')
    .replace(LEAD_VERB, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')

  const words: string[] = []
  for (const w of cleaned.split(' ')) {
    const bare = w.replace(/[^\p{L}\p{N}'’-]/gu, '')
    if (!bare) continue
    // Skip stopwords only while nothing has been kept yet, so "notch on wake"
    // does not become "notch wake".
    if (!words.length && STOP.has(bare.toLowerCase())) continue
    words.push(bare)
    if (words.length >= maxWords) break
  }
  if (!words.length) return 'New task'

  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ')
    .slice(0, 60)
}
