// desktop/engine-overrides/electron/notetaker/notesSummary.ts
//
// Generates title/summary/key points/decisions/action items from a
// meeting's CLEANED transcript (never raw — see transcriptCleanup.ts and
// runNotetakerPipeline in notetakerInit.ts, which only calls this after
// cleanup has succeeded) through the user's own headless Claude Code/Codex
// CLI — 2026-08-25 spec §5.

import { runHeadlessAgent, type HeadlessProvider } from './headlessAgent'
import type { TranscriptSegment } from './transcriptMerge'
import { createNotetakerLogger } from './notetakerLog'
import { extractJson } from './extractJson'

const log = createNotetakerLogger('notes-summary')

export const DEFAULT_SUMMARY_PROMPT =
  'You are producing meeting notes from a cleaned meeting transcript. Produce: a short, specific title ' +
  '(a few descriptive words — not one word, not a full sentence); a plain-language summary of what the meeting ' +
  'was about and what happened; a list of key points discussed; a list of any decisions that were made; a list ' +
  'of any action items, naming who owns each one if that\'s clear from the transcript. Only include items in a ' +
  'list if the transcript actually contains that kind of content — never invent items to fill a section. ' +
  'Return this as JSON: {title, summary, keyPoints: string[], decisions: string[], actionItems: string[]}. ' +
  'Output ONLY that JSON object — no markdown code fence, no explanation, no other text before or after it.'

export type MeetingNotes = {
  title: string
  summary: string
  keyPoints: string[]
  decisions: string[]
  actionItems: string[]
}

/** Plain channel-labeled prose, not raw JSON segment structure — this pass
 *  produces prose, not a 1:1 mapping, so there's nothing positional worth
 *  preserving the way cleanup's {id, text} shape matters. */
export function buildSummaryInput(segments: TranscriptSegment[], prompt: string): string {
  const transcript = segments.map((s) => `${s.channel}: ${s.text}`).join('\n')
  return `${prompt}\n\n${transcript}`
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

/** Pure. Requires non-empty title + summary to count as a real result —
 *  anything short of that (unparseable JSON, missing/non-string title or
 *  summary) returns null, per spec §5's success/failure line. The three
 *  list fields default to [] when absent, since the prompt explicitly
 *  allows omitting empty sections. */
export function parseSummaryOutput(raw: string): MeetingNotes | null {
  // extractJson handles the real, live-observed shape: Claude Code's -p
  // mode commonly wraps its answer in a ```json fence even when told not
  // to — a bare JSON.parse(raw) rejected that outright and was the actual
  // cause of summarization failing every time, not a real CLI/model
  // problem.
  const parsed = extractJson(raw, 'object')
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  const title = obj.title
  const summary = obj.summary
  if (typeof title !== 'string' || title.length === 0) return null
  if (typeof summary !== 'string' || summary.length === 0) return null
  return {
    title,
    summary,
    keyPoints: asStringArray(obj.keyPoints),
    decisions: asStringArray(obj.decisions),
    actionItems: asStringArray(obj.actionItems),
  }
}

export type SummaryResult =
  | { ok: true; notes: MeetingNotes }
  | { ok: false; error: string }

export async function generateNotes(
  segments: TranscriptSegment[],
  provider: HeadlessProvider,
  promptOverride?: string | null,
  runAgent: typeof runHeadlessAgent = runHeadlessAgent,
): Promise<SummaryResult> {
  const prompt = promptOverride ?? DEFAULT_SUMMARY_PROMPT
  const input = buildSummaryInput(segments, prompt)
  const result = await runAgent(provider, input)
  if (!result.ok) {
    log.error('summary call failed', { provider, error: result.error })
    return { ok: false, error: result.error }
  }
  const notes = parseSummaryOutput(result.output)
  if (!notes) {
    log.error('summary response was not usable (missing title/summary or unparseable)', { provider, outputPreview: result.output.slice(0, 200) })
    return { ok: false, error: 'response missing title/summary or unparseable' }
  }
  log.debug('summary completed', { provider, title: notes.title, keyPointCount: notes.keyPoints.length, decisionCount: notes.decisions.length, actionItemCount: notes.actionItems.length })
  return { ok: true, notes }
}
