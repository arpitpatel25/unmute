// Unmute Remote — group identity: the one place two group labels are judged
// to name the same stream.
//
// WHY THIS EXISTS. There was no normalization anywhere. `setGroup` trimmed and
// truncated to 32 characters; every other comparison — the rename walk, the
// live-set builder that feeds the router its vocabulary, the wall's section
// buckets — was exact string equality. So "unmute" and "Unmute" were two
// streams, and the wall showed both.
//
// Separator folding is not cosmetic either. Two independent places derive a
// group and they spell it differently by nature: an imported session takes the
// cwd BASENAME ("unmute-cloud"), and the router takes the user's SPOKEN words
// ("unmute cloud"). Neither is wrong; they simply have to land on one key.
//
// PURE by construction (no fs, no electron, no clock) so every rule below is
// table-testable — house style, same as vadPolicy/correctionGate/surface.

/**
 * The identity of a group label: what two labels must share to BE the same
 * group. Not a display value — never render this. The label the user sees is
 * whatever they (or the router) actually wrote; this is only for comparison
 * and for uniqueness in the registry.
 *
 * Returns '' for anything with no letters or digits in it, which reads as "no
 * group" — a label of punctuation is not a stream.
 */
export function groupKey(label: string | null | undefined): string {
  if (!label) return ''
  const folded = label
    .toLowerCase()
    // Separators become spaces BEFORE collapsing, so "unmute-cloud",
    // "unmute_cloud" and "unmute cloud" converge rather than diverge.
    .replace(/[-_/]+/g, ' ')
    // Everything that is not a letter, digit or space is punctuation around
    // the words — quotes the model left in, a trailing period, stray commas.
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return folded
}

/** Do these two labels name the same stream? Two ABSENT groups are not the
 *  same group — they are both ungrouped, which is the absence of a stream
 *  rather than a shared one, and folding them together would put every
 *  ungrouped task in one bucket. */
export function sameGroup(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = groupKey(a)
  if (!ka) return false
  return ka === groupKey(b)
}
