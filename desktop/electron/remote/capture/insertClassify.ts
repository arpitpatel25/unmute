// What KIND of thing did the user just copy?
//
// The system is not intelligent and cannot know what a copied thing MEANS. It
// does not need to — every branch here is a deterministic check. Meaning is
// never inferred; only shape.
//
// FENCED IS THE DEFAULT; INLINE MUST BE EARNED. Fencing something short is a
// cosmetic annoyance. Inlining something long or unrecognised wrecks the
// sentence AND destroys the boundary irrecoverably. So the unknown case falls
// to the cheap failure.
//
// Pure module: the on-disk check is injected, so this tests without a
// filesystem.

import type { InsertKind } from './types'

/** A single line longer than this reads as a block. 200 is about two lines of
 *  wrapped prose — past that, inlining stops being readable. */
export const LINE_MAX_CHARS = 200

const URL_RE = /^https?:\/\/\S+$/
const ABS_PATH_RE = /^(?:\/|~\/)/

export function classifyText(
  content: string,
  exists: (path: string) => boolean = () => false,
): InsertKind {
  const t = content.trim()
  if (!t) return 'block'
  if (/[\r\n]/.test(t)) return 'block'

  if (URL_RE.test(t)) return 'url'
  // A path only counts if it is really there. An absolute-looking string that
  // is not on disk is just text the user copied.
  if (ABS_PATH_RE.test(t) && exists(t)) return 'path'
  if (t.length <= LINE_MAX_CHARS) return 'line'
  return 'block'
}
