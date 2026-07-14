// promptTail — build the Whisper decoder-context prompt from the PREVIOUS
// chunk's transcript. Whisper natively conditions each 30s window on the
// prior window's text; our chunk cuts broke that. This restores it.
//
// FAIL-SAFE CONTRACT (decided 2026-07-15): '' means "send no prompt" —
// exactly today's behavior. Junky/hallucinated context is worse than none,
// so anything suspicious returns ''.
// Pure module: unit-tested by promptTail.test.ts.

const JUNK_RE = /^\s*(?:thanks? for watching[.!]?|please subscribe[.!]?|thank you[.!]?|bye[.!]?|see you next time[.!]?)\s*$/i

const DEFAULT_MAX_CHARS = 200

export function promptTail(text: string | null | undefined, maxChars: number = DEFAULT_MAX_CHARS): string {
  if (!text) return ''
  const t = text.trim()
  if (t.length < 4) return ''
  if (JUNK_RE.test(t)) return ''
  if (t.length <= maxChars) return t
  // Take the tail, then drop the leading partial word so the prompt starts clean.
  let tail = t.slice(-maxChars)
  const firstSpace = tail.indexOf(' ')
  if (firstSpace > 0 && firstSpace < tail.length - 1) tail = tail.slice(firstSpace + 1)
  return tail.trim()
}
