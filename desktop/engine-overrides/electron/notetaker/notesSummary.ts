// desktop/engine-overrides/electron/notetaker/notesSummary.ts
//
// Generates title/summary/key points/decisions/action items from a
// meeting transcript through the user's selected connected agent. The
// cleaned transcript is preferred; raw STT text is the deliberate fallback
// when optional cleanup fails, so note generation remains useful.
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
import { mergeAdjacentSpeakerTurns, type TranscriptSegment } from './transcriptMerge'
import { createNotetakerLogger } from './notetakerLog'
import { extractJson } from './extractJson'

const log = createNotetakerLogger('notes-summary')

/** A note can be generated either by a connected local CLI agent or the
 * managed cloud agent. Desktop-driver agents remain deliberately excluded:
 * they have no safe, non-interactive background execution API yet. */
export type NoteProvider = HeadlessProvider | 'managed'

const FIXED_SUMMARY_PREAMBLE = 'You are producing meeting notes from a recorded meeting transcript.'

export const DEFAULT_SUMMARY_INSTRUCTIONS =
  'Produce a short, specific title (a few descriptive words — not one word, not a full sentence) and put the ' +
  'complete note in summary as clean Markdown. Use 2–5 specific ## headings and bullet lists under every heading, ' +
  'in the style of a meeting document. Use topical headings such as ## Status, ## Decisions, ## Blockers, and ' +
  '## Next steps only when supported; never use a bare paragraph recap. Do not write a conclusion or third-person ' +
  'recap. Leave keyPoints, decisions, actionItems, and openQuestions as empty arrays; put all rendered content in ' +
  'summary. Only include content the transcript actually supports — never invent items.'

const FIXED_SUMMARY_CONTRACT =
  'LANGUAGE\n\n' +
  'The transcript may contain English, Hindi, Hinglish, Devanagari, and code-switched speech. Understand all ' +
  'of it and incorporate every clear, meaningful point. Write the entire output in clear English. Translate the ' +
  'meaning of Hindi/Hinglish into English, but keep product names, feature names, tool names, and technical terms ' +
  'exactly as they appear in the transcript.\n\n' +

  'GARBLED CONTENT\n\n' +
  'Some segments may be garbled or unintelligible. Ignore them. Base every point only on content you can clearly ' +
  'understand. Never reconstruct meaning from noise.\n\n' +

  'NOTES STYLE\n\n' +
  'Write a self-contained Markdown note, not a recap. Every non-empty section must use concise bullet lists below ' +
  'a specific ## heading; do not write unstructured body paragraphs. Use direct, neutral statements. Do not narrate ' +
  'the conversation or write phrases such as "You said", "they said", "the speaker ' +
  'discussed", or a concluding assessment. Do not mention transcript labels. Put all rendered content in `summary`.\n\n' +

  'DECISIONS AND ACTION ITEMS\n\n' +
  'A decision is something the speakers explicitly settled on — leave it out of `decisions` if the transcript ' +
  'shows it was still being discussed or left open. For an action item\'s owner, use only an explicit person name ' +
  'from the transcript — never guess or invent an owner; omit it if it isn\'t clear.\n\n' +

  'OPEN QUESTIONS\n\n' +
  'Include unresolved questions under an appropriate Markdown heading in `summary`. Keep `openQuestions` empty, ' +
  'like the other legacy list fields.\n\n' +

  'INSUFFICIENT SIGNAL\n\n' +
  'A short, casual, or test conversation is still valid source material: produce useful notes whenever any clear, ' +
  'meaningful speech is present, even if there are no decisions or action items. Only if the transcript contains no ' +
  'semantically understandable speech at all, return an empty `summary` rather than a generic statement that the ' +
  'recording was unclear.\n\n' +


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
  const transcript = mergeAdjacentSpeakerTurns(segments)
    .map((s) => `${s.channel === 'mic' ? 'Microphone' : (s.speakerName || 'System audio')}: ${s.text}`)
    .join('\n')
  return `${FIXED_SUMMARY_PREAMBLE}\n\n${instructions}\n\n${FIXED_SUMMARY_CONTRACT}\n\n${transcript}`
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
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
  const title = typeof obj.title === 'string' ? obj.title.trim() : ''
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
  if (!title || !summary) return null
  return {
    title,
    summary,
    keyPoints: asStringArray(obj.keyPoints),
    decisions: asStringArray(obj.decisions),
    actionItems: asStringArray(obj.actionItems),
    openQuestions: asStringArray(obj.openQuestions),
  }
}

/** Pure. When the model's response wasn't usable JSON but the call itself
 *  produced real text, this is what stands in for a proper MeetingNotes —
 *  the raw output becomes the summary verbatim, every list stays empty,
 *  and `title` is left blank (never fabricated) so the caller keeps
 *  whatever title the meeting already had rather than overwrite it with
 *  something invented. Returns null when there's nothing worth keeping at
 *  all (empty/whitespace-only output) — that case is still a real failure. */
export function buildDegradedNotes(raw: string): MeetingNotes | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // A malformed structured response must not be rendered as a JSON blob in
  // the Notes UI. This is the exact failure that produced a literal
  // {"title":"", ...} card: the model returned a notes-shaped object whose
  // fields were empty or double-encoded. Preserve genuine prose fallback,
  // but treat JSON-shaped output as a failed structured response.
  if (extractJson(trimmed, 'object')) return null
  return { title: '', summary: trimmed, keyPoints: [], decisions: [], actionItems: [], openQuestions: [] }
}

/** A model sometimes turns a failed recording into a polished-looking but
 * useless “most of the recording was unclear” note. That is status text, not
 * meeting content, and must never occupy the Notes document. */
function isNoSignalNote(notes: MeetingNotes): boolean {
  if (notes.keyPoints.length || notes.decisions.length || notes.actionItems.length || notes.openQuestions.length) return false
  const normalized = notes.summary
    .replace(/^\s*#{1,6}\s*(?:notes?|summary)\s*$/gim, '')
    .replace(/^\s*[-*]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  return /^(?:large portions? of (?:the )?recording (?:were|was) unclear and could not be used|the recording (?:was|is) (?:mostly )?unclear|not enough clear speech(?: to generate notes)?)\.?$/.test(normalized)
}

export type SummaryResult =
  | { ok: true; notes: MeetingNotes; degraded?: boolean }
  | { ok: false; error: string }

type NotesRunner = (provider: NoteProvider, input: string) => Promise<{ ok: true; output: string } | { ok: false; error: string }>

async function runNotesAgent(provider: NoteProvider, input: string): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  if (provider !== 'managed') return runHeadlessAgent(provider, input)
  try {
    // Keep the local CLI path dependency-light. paywall-route reaches app
    // window/balance infrastructure, which is needed only for the managed
    // provider and would otherwise make pure note-generation tests require a
    // fully booted Electron app.
    const { tryManagedLLM } = await import('../paywall/paywall-route')
    const result = await tryManagedLLM([
      { role: 'system', content: 'Generate the requested meeting notes. Follow the requested JSON contract exactly.' },
      { role: 'user', content: input },
    ], { temperature: 0.2, maxTokens: 4000 })
    return result?.text
      ? { ok: true, output: result.text }
      : { ok: false, error: 'Managed cloud agent is unavailable. Connect a supported note agent and retry.' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function generateNotes(
  segments: TranscriptSegment[],
  provider: NoteProvider,
  instructionsOverride?: string | null,
  runAgent: NotesRunner = runNotesAgent,
): Promise<SummaryResult> {
  const instructions = instructionsOverride ?? DEFAULT_SUMMARY_INSTRUCTIONS
  const input = buildSummaryInput(segments, instructions)
  let nextInput = input
  let lastFailure = 'response missing title/summary or unparseable'
  let lastOutput = ''

  // A connected agent occasionally returns the requested JSON shape with
  // every field empty even though the transcript contains clear speech. One
  // corrective retry is cheaper and much less confusing than leaving the
  // meeting permanently at "Notes failed". It is used only for a successful
  // agent call whose output is unusable; transport/auth failures are not
  // repeated. The agent still receives transcript text only, never audio.
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runAgent(provider, nextInput)
    if (!result.ok) {
      log.error('summary call failed', { provider, error: result.error, attempt: attempt + 1 })
      return { ok: false, error: result.error }
    }
    lastOutput = result.output
    const notes = parseSummaryOutput(result.output)
    if (notes && !isNoSignalNote(notes)) {
      log.debug('summary completed', { provider, title: notes.title, keyPointCount: notes.keyPoints.length, decisionCount: notes.decisions.length, actionItemCount: notes.actionItems.length, openQuestionCount: notes.openQuestions.length, attempt: attempt + 1 })
      return { ok: true, notes }
    }
    if (notes && isNoSignalNote(notes)) {
      lastFailure = 'Not enough clear speech was captured to generate meeting notes.'
    } else {
      // The call succeeded and produced real prose but not the requested
      // JSON shape. Keep that paid-for generation rather than throwing it
      // away; JSON-shaped empty/malformed output is retried instead.
      const degradedNotes = buildDegradedNotes(result.output)
      if (degradedNotes && !isNoSignalNote(degradedNotes)) {
        log.warn('summary response was not structured JSON — falling back to the raw output as an unstructured summary', { provider, outputPreview: result.output.slice(0, 200) })
        return { ok: true, notes: degradedNotes, degraded: true }
      }
    }

    if (attempt === 0) {
      log.warn('summary response was empty or unusable — retrying once with a corrective instruction', { provider, outputPreview: result.output.slice(0, 300) })
      nextInput = `${input}\n\nCORRECTION FOR THIS RETRY\n\nThe previous response was empty or unusable. The transcript contains source speech. Produce the requested specific Markdown notes from every clear point, even if this is only a short or casual test recording. Do not return empty title or summary fields.`
    }
  }

  log.error('summary response was not usable after corrective retry', { provider, outputPreview: lastOutput.slice(0, 300) })
  return { ok: false, error: lastFailure }
}
