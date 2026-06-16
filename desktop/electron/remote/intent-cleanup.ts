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

const log = createLogger('intent-cleanup')

/** Injected LLM completion (provided by the OSS adapter — managed or BYOK). */
export type CompleteFn = (messages: Array<{ role: 'system' | 'user'; content: string }>) => Promise<string>

const SYSTEM_PROMPT = [
  'You clean up a voice transcript into a single clear command for a computer assistant.',
  'Rules: remove filler ("uh", "um", "like"), resolve self-corrections (keep the final intent),',
  'fix obvious speech-to-text errors, and output ONE concise imperative sentence.',
  'Do NOT add steps, do NOT answer or perform the task, do NOT ask questions.',
  'Output only the cleaned command, nothing else.',
].join(' ')

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
      { role: 'system', content: SYSTEM_PROMPT },
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
