// Unmute Remote — intent cleanup (PRD §13.7).
//
// Voice input is messy ("uh, send that file to rishi, no wait the other one").
// Before the command reaches Claude Code we run a LIGHT cleanup pass that turns
// the raw transcript into a clean intent string. This is an ADDED stage on top
// of the existing dictation STT (PRD §2.4.2) — it does NOT replace the STT.
//
// Two hard properties:
//   * Reuse the existing LLM path (managed/BYOK) via an injected complete().
//     This module never knows about providers — it's handed a function.
//   * Graceful passthrough: if cleanup fails / is empty / times out, return the
//     RAW transcript unchanged. A flaky cleanup must never block a dispatch.
//
// Aggressiveness is intentionally tune-in-build (PRD §15.4 #2). The prompt
// below errs light: fix disfluencies + obvious self-corrections, keep intent.

import { createLogger } from './log'
import { getPrompts } from './runtime-config'

const log = createLogger('intent-cleanup')

/** Injected LLM completion (provided by the OSS adapter — managed or BYOK). */
export type CompleteFn = (messages: Array<{ role: 'system' | 'user'; content: string }>) => Promise<string>

// Read the effective prompt at CALL time (getPrompts()), not module-load, so a
// runtime-config update (remote push / local override) takes effect without a
// relaunch. Falls back to the compiled default when no override is present.

export interface CleanupResult {
  intent: string
  cleaned: boolean // true if the LLM produced a usable cleaned string; false ⇒ passthrough
}

/**
 * Clean a raw transcript into an intent string. Always returns *something*
 * usable — on any failure it passes the raw transcript through unchanged.
 */
export async function cleanIntent(rawTranscript: string, complete: CompleteFn): Promise<CleanupResult> {
  const raw = rawTranscript.trim()
  log.event('cleanup-start', { rawLength: raw.length, raw })
  if (!raw) {
    log.warn('empty transcript — nothing to clean')
    return { intent: '', cleaned: false }
  }
  try {
    const out = (await complete([
      { role: 'system', content: getPrompts().intentCleanup },
      { role: 'user', content: raw },
    ]))?.trim()
    if (!out) {
      log.warn('cleanup returned empty — passthrough raw', { raw })
      return { intent: raw, cleaned: false }
    }
    log.event('cleanup-done', { raw, cleaned: out })
    log.ui('intent-resolved', { shown: out }) // PRD §13.4 #1: this is what the user sees in the row
    return { intent: out, cleaned: true }
  } catch (e) {
    log.warn('cleanup failed — passthrough raw (dispatch must not block)', {
      raw,
      error: (e as Error).message,
    })
    log.ui('intent-resolved', { shown: raw, note: 'cleanup-failed-passthrough' })
    return { intent: raw, cleaned: false }
  }
}

/**
 * Generate a short display name (2-5 words) for a task from its intent. Best-effort:
 * returns '' on any failure/oversize so the caller keeps its truncated-intent fallback.
 * Runs ASYNC after dispatch — never on the capture/dispatch hot path.
 */
export async function nameIntent(intent: string, complete: CompleteFn): Promise<string> {
  const raw = (intent || '').trim()
  if (!raw) return ''
  try {
    const out = (await complete([
      { role: 'system', content: getPrompts().taskName },
      { role: 'user', content: raw },
    ]))?.trim().replace(/^["'`]+|["'`.]+$/g, '').trim()
    if (!out || out.length > 48) return ''
    log.event('name-generated', { intent: raw, name: out })
    return out
  } catch (e) {
    log.warn('name generation failed', { error: (e as Error).message })
    return ''
  }
}
