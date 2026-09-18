/**
 * Wall-clock time of a mic chunk's first captured frame.
 *
 * `Date.now()` alone, read when the port message arrives, would also count the
 * chunk's own duration and IPC scheduling. So read the wall clock now and
 * subtract how long ago the chunk's first frame was, measured on the
 * AudioContext's own sample clock — a short-range difference, unaffected by
 * how long the (window-lifetime) context has existed.
 *
 * Deliberately NOT `performance.timeOrigin + performanceTime`: on macOS the
 * performance clock stops while the machine sleeps, and timeOrigin is fixed
 * when the window is created. The widget window is reused for days, so after
 * a night's sleep that mapping dated the mic lane ~9h early (2026-09-15).
 */
export function micChunkWallClockMs(input: {
  nowMs: number
  contextNowSeconds: number
  chunkContextSeconds?: number
  chunkDurationMs: number
}): number {
  const { nowMs, contextNowSeconds, chunkContextSeconds, chunkDurationMs } = input
  if (typeof chunkContextSeconds === 'number' && Number.isFinite(chunkContextSeconds) && Number.isFinite(contextNowSeconds)) {
    const ageMs = (contextNowSeconds - chunkContextSeconds) * 1000
    if (ageMs >= 0) return nowMs - ageMs
  }
  return nowMs - chunkDurationMs
}
