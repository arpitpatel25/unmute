// Held work must survive a crash, a quit, and a restart — that promise is the
// whole reason the scratchpad exists. So the pad is written to disk as it is
// built, atomically (write .tmp, then rename), the pattern status.json and the
// curator store already use.
//
// SETTLE, DO NOT NAG. A pad pinning the pill open until Friday's draft is dealt
// with on Monday turns a calm product into a nagging one. So the CONTENT
// persists while the DEMAND FOR ATTENTION decays: past the idle threshold the
// pill goes back to normal and the pad waits on disk until the scratchpad is
// armed again. It is never auto-deleted — discard is the only way it goes away.
//
// Pure module: no `fs`, no Electron. Everything here is testable with plain
// strings and objects. The task that owns the capture lifecycle wires this to
// disk with the house atomic-write pattern (write `.tmp`, then rename).

import type { Destination, Entry, Pad } from './types'

/** Long enough to cover stepping away from a real piece of work; short enough
 *  that a forgotten pad stops occupying the screen the same day. */
export const SETTLE_IDLE_MS = 30 * 60_000

export function padDirFor(root: string, padId: string): string {
  return `${root}/${padId}`
}

export function serialize(pad: Pad): string {
  return JSON.stringify(pad)
}

const ORIGINS: Destination[] = ['cursor', 'task']

const ENTRY_TYPES = new Set(['segment', 'insert'])

/** Anything unrecognised returns null and the caller starts fresh. A pad is
 *  the user's own work, so a corrupt or partial file must never throw and
 *  must never yield a half-valid object that could deliver a mangled
 *  payload — every field is validated, including that every entry has a
 *  known `type` and a string `id`. */
export function deserialize(raw: string): Pad | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const p = v as Partial<Pad>
  if (typeof p.id !== 'string') return null
  if (typeof p.origin !== 'string' || !ORIGINS.includes(p.origin as Destination)) return null
  if (typeof p.createdAt !== 'number' || typeof p.updatedAt !== 'number') return null
  if (!Array.isArray(p.entries)) return null
  for (const e of p.entries) {
    if (!e || typeof e !== 'object') return null
    const entry = e as Partial<Entry>
    if (typeof entry.type !== 'string' || !ENTRY_TYPES.has(entry.type)) return null
    if (typeof entry.id !== 'string') return null
  }
  return {
    id: p.id,
    origin: p.origin,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    entries: p.entries as Entry[],
  }
}

/** An empty pad has nothing to keep, so the concept of settling does not
 *  apply to it — it never occupies the screen with a demand for attention in
 *  the first place. */
export function shouldSettle(pad: Pad, now: number, idleMs: number = SETTLE_IDLE_MS): boolean {
  if (pad.entries.length === 0) return false
  return now - pad.updatedAt > idleMs
}
