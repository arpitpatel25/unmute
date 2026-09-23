// Which agent makers are on this Mac, for copy that would otherwise name both.
//
// Nothing about an agent that is not installed is shown: a Codex-only Mac never
// reads "Claude Code", and a Claude-only Mac never reads "Codex". The list comes
// from remote:agent-options, which main already filters to detected backends.
//
// EMPTY MEANS "NAME BOTH". Before the probe answers, and on a Mac with no agent
// at all, the copy is telling the user what they could install — so it keeps
// its original wording rather than going blank.

export type Vendor = 'claude' | 'codex'

/** Makers with at least one detected backend, from the backend ids. */
export function vendorsOf(ids: readonly string[]): Vendor[] {
  const out: Vendor[] = []
  if (ids.some((id) => id.startsWith('claude'))) out.push('claude')
  if (ids.some((id) => id.startsWith('codex'))) out.push('codex')
  return out
}

/** May copy about this maker be shown? Yes when it is detected, or when
 *  nothing is (so both are named). */
export function showsVendor(detected: readonly Vendor[], vendor: Vendor): boolean {
  return detected.length === 0 || detected.includes(vendor)
}
