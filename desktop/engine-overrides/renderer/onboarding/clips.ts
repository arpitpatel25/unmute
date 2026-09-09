const CLIP_ROOT = new URL('./clips/', import.meta.url)

/** Stable ids let final founder footage replace placeholders without changing
 *  the journey contract or any product-event wiring. */
export function clipUrl(clipId: string): string {
  if (!clipId) return ''
  return new URL(`${encodeURIComponent(clipId)}.mp4`, CLIP_ROOT).toString()
}
