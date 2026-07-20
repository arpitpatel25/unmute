// Unmute Remote — the Skill Curator's matcher: pure helpers for retrieval
// pre-filter, apply-match merge, and suppression fingerprinting.
//
// This file starts with suppression only (Task 2). Retrieval/apply-match
// helpers land in a later task — see docs/superpowers/plans/
// 2026-07-20-skill-curator-revamp.md (Task 4).
//
// Suppression (Constraint 8 — "Reject → suppress (never re-surface)"):
// rejections are keyed by skill NAME (see curator-store's readRejections /
// appendRejection), so the suppression check is name-anchored — a name that
// was rejected once never resurfaces regardless of how its signature reads
// on a later sweep.

import { createHash } from 'node:crypto'

/** sha256 hex of `${draftName} ${norm}`, where `norm` is `signature`
 *  lowercased, whitespace collapsed to single spaces, and trimmed. Mirrors
 *  curator-writer.ts's contentHash (sha256 hex via node:crypto). */
export function suppressionFingerprint(draftName: string, signature: string): string {
  const norm = signature.toLowerCase().replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(`${draftName} ${norm}`, 'utf8').digest('hex')
}

/** Name-anchored suppression check: true iff some prior rejection was keyed
 *  by this exact skill name. Rejections in this system are keyed by skill
 *  name, so that's the suppression key — a rejected name never re-surfaces. */
export function isSuppressed(name: string, rejections: Array<{ at: string; name: string; reason?: string }>): boolean {
  return rejections.some(r => r.name === name)
}
