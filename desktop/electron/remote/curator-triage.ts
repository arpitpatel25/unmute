/**
 * Curator triage — deterministic struggle metrics + the over-inclusive gate.
 *
 * Answers "is this transcript delta worth an LLM's attention?" from raw JSONL
 * lines (as produced by `readTranscriptDelta` in curator-store.ts). Pure
 * module: no fs, no LLM. The gate controls COST, never merit — it is
 * over-inclusive by design, so keep the boolean formula exactly as spec'd.
 *
 * Transcript-entry shape (mirrors the defensive parsing in
 * skill-usage.ts extractSkillUses / trace-reducer.ts reduceTranscript):
 * each line is JSON with optional `timestamp` (ISO string), `message.role`,
 * and `message.content[]` blocks of `{type:'tool_use', name}` /
 * `{type:'tool_result', is_error}`. Malformed lines are skipped —
 * transcripts can be mid-write.
 */

export interface TriageMetrics {
  wallClockMs: number
  toolCalls: number
  distinctTools: number
  errors: number
  recoveries: number
  userTurns: number
  lines: number
}

interface TranscriptEntry {
  timestamp?: string
  message?: {
    role?: string
    content?: Array<{ type?: string; name?: string; is_error?: boolean }>
  }
}

export function computeTriageMetrics(lines: string[]): TriageMetrics {
  let toolCalls = 0
  let errors = 0
  let recoveries = 0
  let userTurns = 0
  const tools = new Set<string>()
  let firstTs: number | undefined
  let lastTs: number | undefined
  // Error→(any later non-error result) counts as one recovery.
  let pendingError = false

  for (const raw of lines) {
    let entry: TranscriptEntry
    try {
      entry = JSON.parse(raw) as TranscriptEntry
    } catch { continue } // partial/foreign line — skip

    if (typeof entry?.timestamp === 'string') {
      const t = Date.parse(entry.timestamp)
      if (!Number.isNaN(t)) {
        if (firstTs === undefined) firstTs = t
        lastTs = t
      }
    }

    const content = entry?.message?.content
    const blocks = Array.isArray(content) ? content : []
    let sawToolResult = false
    for (const block of blocks) {
      if (block?.type === 'tool_use') {
        toolCalls++
        if (typeof block.name === 'string' && block.name) tools.add(block.name)
      } else if (block?.type === 'tool_result') {
        sawToolResult = true
        if (block.is_error === true) {
          errors++
          pendingError = true
        } else if (pendingError) {
          recoveries++
          pendingError = false
        }
      }
    }

    // A "user turn" = user-role message with NO tool_result block (tool
    // results ride user-role messages in Claude Code transcripts).
    if (entry?.message?.role === 'user' && !sawToolResult) userTurns++
  }

  const wallClockMs =
    firstTs !== undefined && lastTs !== undefined && lastTs !== firstTs
      ? Math.max(0, lastTs - firstTs)
      : 0

  return {
    wallClockMs,
    toolCalls,
    distinctTools: tools.size,
    errors,
    recoveries,
    userTurns,
    lines: lines.length,
  }
}

export interface TriageThresholds {
  minWallClockMs: number
  minToolCalls: number
  minErrors: number
  minUserTurns: number
}

export const DEFAULT_TRIAGE: TriageThresholds = {
  minWallClockMs: 10 * 60_000,
  minToolCalls: 15,
  minErrors: 3,
  minUserTurns: 5,
}

/** Over-inclusive by design: long-and-expensive sessions pass, but heavy
 *  errors or heavy user steering pass on their own. */
export function passesTriage(m: TriageMetrics, t: TriageThresholds = DEFAULT_TRIAGE): boolean {
  return (
    (m.wallClockMs >= t.minWallClockMs && m.toolCalls >= t.minToolCalls) ||
    m.errors >= t.minErrors ||
    m.userTurns >= t.minUserTurns
  )
}
