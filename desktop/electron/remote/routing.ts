// Unmute Remote — utterance routing (v1: default-new + explicit-continue).
//
// DECIDED: this is cheap orchestration, NOT intelligence. We default every
// utterance to a NEW task (fails safe — never mis-injects a command into a
// live session), and only treat it as a continuation when the user gives an
// explicit cue. A Haiku classifier for the ambiguous case is a v2 add-on; this
// pure heuristic handles v1 with zero model calls.

const CONTINUATION_CUES = [
  /^\s*(also|and|then|now|next|after that)\b/i, // leading connectors
  /\b(continue|keep going|carry on|same (one|task|thing))\b/i,
  /\b(that|those|it|them|the (one|result|list|email|file|doc))\b.*\b(too|as well|now)\b/i,
  /^\s*(reply|send|open|forward|delete|do)\b.*\b(it|that|them|the (second|third|first|next|last)\b)/i,
]

/**
 * Heuristic: does this utterance look like a follow-up to an existing session,
 * vs. a brand-new task? Conservative by design — defaults to "new" unless an
 * explicit continuation cue is present.
 */
export function looksLikeContinuation(utterance: string): boolean {
  const u = (utterance || '').trim()
  if (!u) return false
  return CONTINUATION_CUES.some((re) => re.test(u))
}
