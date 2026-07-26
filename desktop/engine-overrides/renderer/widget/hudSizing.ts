/**
 * How tall the HUD window must be for the model list, and which way it grows.
 *
 * Extracted so the arithmetic is testable: it was wrong twice in a row and both
 * times only showed up on screen. The list renders Codex's axes as COLUMNS, so
 * the height is the tallest column — summing every axis asked for a 440px
 * window around a ~230px panel, which is the empty gap above the list, and made
 * the Claude↔Codex change far bigger than the visible one.
 */
export const HUD_BASE = 72
const ROW = 36
const CHROME = 64
const HEADER = 0.8   // the axis caption, in row-heights
const MAX = 440

/** Rows the panel is tall: the tallest column for Codex, the whole list for Claude. */
export function panelRows(
  isCodex: boolean,
  axes: Array<{ values: string[] }>,
  catalogLength: number,
): number {
  if (!isCodex) return catalogLength
  if (!axes.length) return 0
  return Math.max(...axes.map((a) => a.values.length)) + HEADER
}

export function hudHeight(open: boolean, rows: number): number {
  if (!open) return HUD_BASE
  return Math.min(MAX, CHROME + rows * ROW + 12)
}

/**
 * How far to push the content down so the pill does not move.
 *
 * The window grows UPWARD, so the extra height appears above the old top edge;
 * the content is top-aligned, so it must come down by exactly that much. The
 * pill family is drawn at 0.75 scale, and padding inside a scaled element
 * scales with it — hence the divide.
 */
export function contentOffset(height: number, scale = 0.75): number {
  return (height - HUD_BASE) / scale
}
