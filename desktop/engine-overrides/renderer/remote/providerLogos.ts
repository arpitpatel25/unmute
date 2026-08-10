/**
 * THE PROVIDER LOGOS FOR THE RENDERER, in one file.
 *
 * Data URIs rather than files in `assets/`, for the same reason the notch
 * compiles its art in: these marks appear on the pocket, the wall, the panel
 * and the stage, and a missing-image flicker on a surface that repaints as
 * often as the wall is worse than the bytes.
 *
 * EMPTY UNTIL THE REAL FILES ARE EMBEDDED, deliberately. The marks belong to
 * OpenAI and Anthropic; approximating them from memory would put a wrong logo
 * on every card, which is the same failure as the four invented Codex model ids
 * that shipped in this branch a day ago — a confident guess about someone
 * else's product that nothing downstream can catch. `ProviderMark` falls back
 * to the coloured square the wall already used, so an absent asset degrades to
 * the previous design instead of a hole.
 *
 * TO EMBED (from desktop/):
 *   ./native-notch/tools/embed-provider-logo.sh claude ~/path/claude.png
 *   ./native-notch/tools/embed-provider-logo.sh codex  ~/path/codex.png
 * The script writes BOTH this file and ProviderMarkArt.swift, so the two
 * surfaces cannot end up with different art or different sizing.
 */

export interface ProviderLogo {
  /** `data:image/png;base64,…` */
  src: string
  /**
   * How much of the box the logo's INK should occupy.
   *
   * Measured from the file's opaque bounds at embed time, never guessed.
   * Matching the frame does not match the mark: a logo exported with generous
   * internal padding reads smaller than a tight one at the same size, and the
   * eye compares the marks.
   */
  scale: number
}

/** Absent entries render the fallback. Filled by embed-provider-logo.sh. */
export const PROVIDER_LOGOS: Record<'claude' | 'codex', ProviderLogo | null> = {
  claude: null,
  codex: null,
}
