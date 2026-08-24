//
// Best-effort, UNVERIFIED heuristic for "who is Zoom's currently active
// speaker," read from Zoom's own accessibility tree via unmute-native-ax.
//
// WHY UNVERIFIED: confirming Zoom's exact in-call AX-tree shape for a
// speaking-state indicator would require joining a real, live, multi-person
// Zoom call — not available while building this. What IS verified (see
// docs/superpowers/specs/2026-08-24-notetaker-speaker-attribution.md §2):
// native-ax's find()/getTree() genuinely reaches deep into Zoom's real UI
// content (confirmed against Zoom's actual sign-in form — AXTextField
// "Email", AXCheckBox "Keep me signed in", etc. — not just window chrome),
// unlike Chrome, where the same mechanism returns only toolbar/tab-strip
// nodes and never reaches web page content. So the MECHANISM is sound; only
// the exact label pattern Zoom uses for "this person is talking" is a
// documented guess, not a confirmed fact.
//
// This ships with full diagnostics captured on every call — not just the
// nodes that happened to match the heuristic's regex, but EVERY node the
// walk returned, plus whether Zoom resolved at all — specifically so a real
// capture's notetaker log (see notetakerInit.ts, which dumps allNodes in
// full on a session's first poll, and the lightweight scalar fields on
// every poll after that) can be read after a real Zoom call to see what the
// tree actually contains, and this heuristic can be tuned from real data in
// a fast follow-up round. An earlier version of this function only returned
// nodes that already matched the regex in rawCandidates — which meant that
// exactly when the heuristic was wrong (the case this instrumentation
// exists for), every poll produced an empty result indistinguishable from
// "Zoom wasn't running at all" or "Zoom resolved but the window index was
// wrong." allNodes/nodesReturned/totalWalked/axError close that gap: they
// let a human tell those three failure modes apart from the log alone,
// instead of learning nothing from a real call and having to guess again.

export type NativeAxFindResult = {
  app: string
  nodes: Array<{ id: number; role: string; label: string; actions: string[] }>
  total: number
  error?: string
}

export type NativeAxLike = {
  find: (app: string, label: string, role: string) => NativeAxFindResult
}

export type SpeakerPollResult = {
  speakerName: string | null
  candidateCount: number
  rawCandidates: Array<{ role: string; label: string }>
  /** Every node the walk returned, not just regex matches — see header
   *  comment. Large; callers should log this in full only occasionally
   *  (e.g. a session's first poll), not on every tick. */
  allNodes: Array<{ role: string; label: string }>
  /** How many nodes the walk returned. 0 with a non-null axError means Zoom
   *  wasn't resolved at all; 0 with axError null and candidateCount 0 means
   *  Zoom resolved fine but nothing in its tree matched the heuristic. */
  nodesReturned: number
  /** ax.find()'s own reported total, surfaced separately from
   *  nodesReturned in case a future native-ax version ever returns fewer
   *  nodes than it walked (it doesn't today, but nothing here should assume
   *  that stays true). */
  totalWalked: number
  /** ax.find()'s own error field, verbatim, or null. */
  axError: string | null
}

// Common screen-reader conventions for indicating an active speaker —
// documented guess, see header comment.
const SPEAKING_HINT = /\bis speaking\b|\bspeaking now\b|\bactive speaker\b|\btalking\b/i

function emptyResult(nodesReturned: number, totalWalked: number, axError: string | null): SpeakerPollResult {
  return { speakerName: null, candidateCount: 0, rawCandidates: [], allNodes: [], nodesReturned, totalWalked, axError }
}

export function pollZoomSpeaker(ax: NativeAxLike): SpeakerPollResult {
  // The whole body is guarded, not just ax.find() — this function is typed
  // against the abstract NativeAxLike interface, not the concrete addon, so
  // "never throws" has to hold even against a malformed implementation (a
  // node missing expected fields, etc.), not just the real addon's
  // known-well-formed output. Called on a live poll timer during an active
  // capture session — an uncaught throw here would crash that timer.
  try {
    const found = ax.find('zoom.us', '', '')
    if (found.error || !Array.isArray(found.nodes)) {
      return emptyResult(0, found.total ?? 0, found.error ?? null)
    }

    const allNodes = found.nodes.filter((n) => !!n).map((n) => ({ role: n.role, label: n.label }))
    const candidates = found.nodes.filter((n) => n && SPEAKING_HINT.test(n.label ?? ''))
    const rawCandidates = candidates.map((n) => ({ role: n.role, label: n.label }))
    const base = { allNodes, nodesReturned: found.nodes.length, totalWalked: found.total, axError: null as string | null }
    if (candidates.length === 0) {
      return { speakerName: null, candidateCount: 0, rawCandidates, ...base }
    }

    // Strip the matched hint phrase and any surrounding punctuation/parens
    // to recover just the name. First match wins — deterministic, not a
    // guess at "most likely" when multiple candidates exist.
    const rawName = candidates[0].label
      .replace(SPEAKING_HINT, '')
      .replace(/[(),.\-–—]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    return {
      speakerName: rawName.length > 0 ? rawName : null,
      candidateCount: candidates.length,
      rawCandidates,
      ...base,
    }
  } catch {
    return emptyResult(0, 0, null)
  }
}
