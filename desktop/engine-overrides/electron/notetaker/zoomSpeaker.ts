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
// This ships with every candidate node it examined captured in
// rawCandidates specifically so a real capture's notetaker log (which logs
// this function's full result on every poll — see notetakerInit.ts) can be
// read after a real Zoom call to see what the tree actually contains, and
// this heuristic can be tuned from real data in a fast follow-up round —
// the same "ship instrumented, verify from real logs, fix" loop that found
// and fixed this session's real audio-tap bugs.

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
}

// Common screen-reader conventions for indicating an active speaker —
// documented guess, see header comment.
const SPEAKING_HINT = /\bis speaking\b|\bspeaking now\b|\bactive speaker\b|\btalking\b/i

export function pollZoomSpeaker(ax: NativeAxLike): SpeakerPollResult {
  let found: NativeAxFindResult
  try {
    found = ax.find('zoom.us', '', '')
  } catch {
    return { speakerName: null, candidateCount: 0, rawCandidates: [] }
  }
  if (found.error || !Array.isArray(found.nodes)) {
    return { speakerName: null, candidateCount: 0, rawCandidates: [] }
  }

  const candidates = found.nodes.filter((n) => SPEAKING_HINT.test(n.label ?? ''))
  const rawCandidates = candidates.map((n) => ({ role: n.role, label: n.label }))
  if (candidates.length === 0) {
    return { speakerName: null, candidateCount: 0, rawCandidates }
  }

  // Strip the matched hint phrase and any surrounding punctuation/parens to
  // recover just the name. First match wins — deterministic, not a guess
  // at "most likely" when multiple candidates exist.
  const rawName = candidates[0].label
    .replace(SPEAKING_HINT, '')
    .replace(/[(),.\-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return {
    speakerName: rawName.length > 0 ? rawName : null,
    candidateCount: candidates.length,
    rawCandidates,
  }
}
