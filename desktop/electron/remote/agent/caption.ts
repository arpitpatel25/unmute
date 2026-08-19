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
