// desktop/engine-overrides/electron/notetaker/notesSummary.ts
//
// Generates title/summary/key points/decisions/action items from a
// meeting's CLEANED transcript (never raw — see transcriptCleanup.ts and
// runNotetakerPipeline in notetakerInit.ts, which only calls this after
// cleanup has succeeded) through the user's own headless Claude Code/Codex
// CLI — 2026-08-25 spec §5.
//
// PROMPT IS TWO PARTS (2026-08-26): FIXED_SUMMARY_PREAMBLE/FIXED_SUMMARY_
// CONTRACT bookend the editable instructions text (the user's own
// override, or DEFAULT_SUMMARY_INSTRUCTIONS) and are never shown in — or
// editable from — Settings. The contract carries the output JSON shape
// this file's own parser depends on, plus judgment calls we want held
// constant (language, garbled content, the decisions/ownership bar) — so
// all of that holds regardless of what the editable instructions say.
// Unlike this file, transcriptCleanup.ts's prompt has NO editable seam at
// all — see that file's own header for why.

import { runHeadlessAgent, type HeadlessProvider } from './headlessAgent'
import type { TranscriptSegment } from './transcriptMerge'
import { createNotetakerLogger } from './notetakerLog'
import { extractJson } from './extractJson'

const log = createNotetakerLogger('notes-summary')

const FIXED_SUMMARY_PREAMBLE = 'You are producing meeting notes from a cleaned meeting transcript.'

export const DEFAULT_SUMMARY_INSTRUCTIONS =
  'Produce: a short, specific title (a few descriptive words — not one word, not a full sentence); a ' +
  'plain-language summary of what the meeting was about and what happened; a list of key points discussed; a ' +
  'list of any decisions that were made; a list of any action items, naming who owns each one if that\'s clear ' +
  'from the transcript. Only include items in a list if the transcript actually contains that kind of content ' +
  '— never invent items to fill a section.'

const FIXED_SUMMARY_CONTRACT =
  'LANGUAGE\n\n' +
  'The transcript may contain multiple languages, including romanized speech from code-switching. Write the ' +
  'entire output in the single dominant language of the transcript. Translate mixed-language content into that ' +
  'language rather than reproducing it as spoken. Do not translate product names, feature names, tool names, or ' +
  'technical terms — keep those exactly as they appear in the transcript.\n\n' +

  'GARBLED CONTENT\n\n' +
  'Some segments may be garbled or unintelligible. Ignore them. Base every point only on content you can clearly ' +
  'understand. Never reconstruct meaning from noise.\n\n' +

  'DECISIONS AND ACTION ITEMS\n\n' +
  'A decision is something the speakers explicitly settled on — leave it out of `decisions` if the transcript ' +
  'shows it was still being discussed or left open. For an action item\'s owner, use only the literal speaker ' +
  'label shown in the transcript — never guess or invent an owner; omit it if it isn\'t clear.\n\n' +

  'OPEN QUESTIONS\n\n' +
  'List, in `openQuestions`, anything the meeting raised but did not resolve — a question left unanswered, or a ' +
  'choice the speakers explicitly disagreed on or never settled. Do not duplicate an item that is already in ' +
  '`decisions`.\n\n' +

  'Return this as JSON: {title, summary, keyPoints: string[], decisions: string[], actionItems: string[], ' +
  'openQuestions: string[]}. ' +
  'Output ONLY that JSON object — no markdown code fence, no explanation, no other text before or after it.'

export type MeetingNotes = {
  title: string
  summary: string
  keyPoints: string[]
  decisions: string[]
  actionItems: string[]
  openQuestions: string[]
}

/** Prose transcript, not raw JSON segment structure — this pass produces
 *  prose, not a 1:1 mapping, so there's nothing positional worth preserving
 *  the way cleanup's {id, text} shape matters. Each line is labeled the
 *  same way the Transcript tab itself labels speakers (mic → "You"; system
 *  → its resolved speaker name, else "Them") — FIXED_SUMMARY_CONTRACT's
 *  action-item rule tells the model to use exactly these literal labels
 *  for ownership, never to invent a name. `instructions` is the editable
 *  middle third; the fixed preamble and contract always bookend it,
 *  whatever it says. */
export function buildSummaryInput(segments: TranscriptSegment[], instructions: string): string {
  const transcript = segments
    .map((s) => `${s.channel === 'mic' ? 'You' : (s.speakerName || 'Them')}: ${s.text}`)
    .join('\n')
  return `${FIXED_SUMMARY_PREAMBLE}\n\n${instructions}\n\n${FIXED_SUMMARY_CONTRACT}\n\n${transcript}`
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
    openQuestions: asStringArray(obj.openQuestions),
  }
}

export type SummaryResult =
  | { ok: true; notes: MeetingNotes }
  | { ok: false; error: string }

export async function generateNotes(
  segments: TranscriptSegment[],
  provider: HeadlessProvider,
  instructionsOverride?: string | null,
  runAgent: typeof runHeadlessAgent = runHeadlessAgent,
): Promise<SummaryResult> {
  const instructions = instructionsOverride ?? DEFAULT_SUMMARY_INSTRUCTIONS
  const input = buildSummaryInput(segments, instructions)
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
  log.debug('summary completed', { provider, title: notes.title, keyPointCount: notes.keyPoints.length, decisionCount: notes.decisions.length, actionItemCount: notes.actionItems.length, openQuestionCount: notes.openQuestions.length })
  return { ok: true, notes }
}
