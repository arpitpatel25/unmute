// desktop/engine-overrides/electron/notetaker/extractJson.ts
//
// Live-diagnosed root cause of cleanup/summary failing every time: both
// transcriptCleanup.ts and notesSummary.ts called JSON.parse() directly on
// a headless CLI's raw stdout, assuming bare JSON. Claude Code's -p mode
// (and most models, asked or not) commonly wraps its answer in a markdown
// code fence — ```json\n[...]\n``` — which a bare JSON.parse rejects
// outright, even though the actual JSON inside is perfectly well-formed.
// This is the single place both files now go through instead of parsing
// raw output themselves.

/**
 * Tries, in order: bare JSON (the ideal case, still fastest and most
 * common for well-behaved responses); a fenced code block (```json ... ```
 * or ``` ... ```, case-insensitive on the language tag); then a bracket
 * scan from the first `expected`-matching open bracket to the LAST
 * matching close bracket in the whole string, for prose-wrapped JSON with
 * no fence at all ("Here's the corrected transcript: [...]. Let me know
 * if..."). Returns `undefined` if nothing in the string parses — never
 * throws. Callers still validate the parsed VALUE's shape themselves
 * (this only gets them a JSON value to check, not a guarantee it's the
 * right one).
 */
export function extractJson(raw: string, expected: 'array' | 'object'): unknown {
  const trimmed = raw.trim()

  try {
    return JSON.parse(trimmed)
  } catch { /* fall through */ }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim())
    } catch { /* fall through */ }
  }

  const openChar = expected === 'array' ? '[' : '{'
  const closeChar = expected === 'array' ? ']' : '}'
  const start = trimmed.indexOf(openChar)
  const end = trimmed.lastIndexOf(closeChar)
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch { /* fall through */ }
  }

  return undefined
}
