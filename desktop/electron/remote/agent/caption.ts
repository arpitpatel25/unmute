/**
 * The caption: how the Unmute Agent speaks back.
 *
 * Not speech — synthesised voices are unwelcome, unusable in company, and
 * slower to take in than a glance. Not a panel or a widget either: anything
 * that slides in with a background and a border reads as ANOTHER APP OPENING,
 * which is the precise feeling an agent that exists to abstract the session
 * away must avoid. A caption belongs to the machine. The user asked their
 * computer something, and their computer answered.
 *
 * The Agent therefore writes ONE user-facing string and it IS the answer —
 * never a short version of a longer one. Whichever field the system consumes
 * is the one the model takes seriously; given a "full response" as well, the
 * caption becomes an afterthought, a summary of its own essay. The long
 * version already exists anyway: the session transcript, reachable in one step
 * from the logged provider session id.
 *
 * When the answer does not fit, the instruction is not to compress it but to
 * put the material where the user asked for it and say where it went. The
 * clipping below is a backstop for when that is ignored, not the mechanism.
 */

/** About thirty-five words: two lines at caption size. */
export const MAX_CAPTION_LENGTH = 200

/** Floor and ceiling on how long a caption stays. */
export const CAPTION_MIN_DWELL_MS = 2_500
export const CAPTION_MAX_DWELL_MS = 8_000

const DWELL_BASE_MS = 1_500
const DWELL_PER_CHAR_MS = 45

/**
 * How long to leave it on screen.
 *
 * Video captions are timed to the speech they transcribe. These have no clock,
 * so length is the only honest proxy — too short and it is missed, too long
 * and it is litter. The ceiling is matched to the character cap, so the
 * longest permitted caption gets the longest permitted dwell and no more.
 */
export function captionDwellMs(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  const raw = DWELL_BASE_MS + DWELL_PER_CHAR_MS * trimmed.length
  return Math.min(CAPTION_MAX_DWELL_MS, Math.max(CAPTION_MIN_DWELL_MS, raw))
}

export interface FittedCaption {
  text: string
  /** True when the backstop had to clip — worth logging, it means the model
   *  ignored the instruction to place detail and say where it went. */
  truncated: boolean
}

/**
 * Reduce whatever the model produced to something the surface can actually
 * render: one line, no markup, within the cap.
 *
 * Markup is stripped rather than shown because the caption is drawn as plain
 * text — asterisks and backticks would appear literally, which is how a
 * carefully-worded answer ends up looking like a bug.
 */
export function fitCaption(raw: string): FittedCaption {
  const flattened = raw
    .replace(/```[\s\S]*?```/g, ' ')       // fenced blocks say nothing here
    .replace(/[*_`]+/g, '')                 // emphasis and code marks
    .replace(/^\s*#{1,6}\s+/gm, '')         // headings
    .replace(/^\s*>\s?/gm, '')              // block quotes
    .replace(/^\s*[-+]\s+/gm, '')           // bullets
    .replace(/\s+/g, ' ')                   // and it is ONE line
    .trim()

  if (!flattened) return { text: '', truncated: false }
  if (flattened.length <= MAX_CAPTION_LENGTH) return { text: flattened, truncated: false }
  // Clip on a word boundary where one is near, so the ellipsis reads as an
  // ending rather than a machine failure.
  const hard = flattened.slice(0, MAX_CAPTION_LENGTH - 1)
  const lastSpace = hard.lastIndexOf(' ')
  const body = lastSpace > MAX_CAPTION_LENGTH - 40 ? hard.slice(0, lastSpace) : hard
  return { text: `${body.trimEnd()}…`, truncated: true }
}


/**
 * How long the answer is allowed to stay: a caption, or the caption held open.
 *
 * THE SURFACE FOLLOWS THE ANSWER, and neither the model nor a tool chooses it.
 * Asking the model to pick would hand it a second thing to get wrong on a
 * surface with no window to inspect; deriving it from the text cannot drift.
 *
 * The caption stays exactly what it was — one line, a few seconds, no chrome.
 * What changes is the overflow case. It used to clip to an ellipsis, which
 * fails the one job the sentence had: "summarise that meeting note" has an
 * answer that IS the deliverable, and a clipped deliverable is a broken
 * promise wearing a tick.
 *
 * So an answer that does not fit is not compressed and not truncated. It is
 * held: same black slabs, same centred column, same voice, no timer. It is
 * still not the notch, and still not a window — the notch stays independent of
 * anything the Agent says, which is the boundary that makes the Agent read as
 * the computer answering rather than an app opening.
 */
export type AnswerSurface = 'caption' | 'reader'

export interface PresentedAnswer {
  surface: AnswerSurface
  /** What to display. A caption is fitted; a reader keeps the whole answer. */
  text: string
  /** Milliseconds to hold a caption. Zero for a reader, which has no clock. */
  dwellMs: number
}

/**
 * A reader is never opened for a near miss.
 *
 * Held open, a two-line answer is a small permanent box the user has to go and
 * dismiss — worse than the caption it replaced. The gap has to be wide enough
 * that reading it slowly is genuinely the point.
 */
export const READER_THRESHOLD = Math.round(MAX_CAPTION_LENGTH * 1.5)

export function presentAnswer(raw: string): PresentedAnswer {
  const flattened = raw.trim()
  if (!flattened) return { surface: 'caption', text: '', dwellMs: 0 }

  const fitted = fitCaption(flattened)
  if (!fitted.truncated) {
    return { surface: 'caption', text: fitted.text, dwellMs: captionDwellMs(fitted.text) }
  }
  if (flattened.length <= READER_THRESHOLD) {
    // Just over: clipping loses a clause, holding costs a dismissal. Clip.
    return { surface: 'caption', text: fitted.text, dwellMs: captionDwellMs(fitted.text) }
  }
  // Markup is still stripped — the surface draws plain text either way — but
  // the line breaks the model chose are kept, because at this length they are
  // how it is meant to be read.
  return { surface: 'reader', text: readerText(flattened), dwellMs: 0 }
}

/** The caption's cleanup, minus the flattening to one line. */
export function readerText(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`]+/g, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
