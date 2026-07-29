// Unmute Remote — dispatch payload builder (PRD §8.1, decision #3).
//
// We canNOT inject instructions mid-turn (the TUI processes one turn
// sequentially), and we don't want to type the whole contract every task.
// So the STABLE contract (status-file protocol, heartbeat cadence, atomic
// writes, ask-channel, recipe-suggestion) lives in an auto-loaded file
// (contract/contract.md installed into the session cwd / skills dir), and
// only the PER-TASK bits — this task's status-file path + the cleaned intent
// — are typed into stdin (decision #3).
//
// Keep this terse. The obligations are in the loaded contract, not here.

import { createLogger } from './log'
import type { Confidence } from './recipe-store'
import { devFields } from './curator-devlog'

const log = createLogger('dispatch-prompt')

const STANCE: Record<Confidence, string> = {
  low: 'Unverified lead from a past run — treat skeptically and derive independently if it fails',
  medium: 'Usually-right approach from past runs — confirm as you go',
  high: 'Established approach',
}

export interface DispatchInput {
  /** The cleaned intent string (post intent-cleanup, PRD §13.7). */
  intent: string
  /** Absolute path of THIS task's status file (Unmute-owned, PRD §6.1). */
  statusPath: string
  /** Absolute path of THIS task's recipe-suggestion scratch file (PRD §8.1). */
  recipeScratchPath?: string
  /** Nursery (low/medium) leads to inject HEDGED — never auto-fired skills. */
  nurseryRecipes?: Array<{ name: string; confidence: Confidence; body: string }>
  /** One-line "confirm before relying" notes for stale-high graduated skills. */
  staleNotes?: string[]
  /** The full operating contract, INLINE. Only for project-bound spawns: the
   *  agent runs in the USER'S directory, where we never write a CLAUDE.md — so
   *  the contract can't auto-load and rides in the payload instead. */
  contractText?: string
}

/**
 * Build the exact text typed into the REPL's stdin to dispatch one task.
 * Short by construction — the full contract is already loaded (decision #3) —
 * EXCEPT project-bound spawns, which carry the contract inline (contractText).
 */
export function buildDispatch({ intent, statusPath, recipeScratchPath, nurseryRecipes, staleNotes, contractText }: DispatchInput): string {
  const lines = [
    `[Unmute Remote task]`,
    `Task: ${intent}`,
    `Status file (yours to update per the ${contractText ? 'Unmute contract below' : 'loaded Unmute contract'}): ${statusPath}`,
  ]
  if (recipeScratchPath) {
    lines.push(`Recipe-suggestion scratch file (write a suggestion here only if you learned a better/repeatable way): ${recipeScratchPath}`)
  }
  for (const note of staleNotes ?? []) lines.push(`Note: ${note}`)
  for (const r of nurseryRecipes ?? []) {
    lines.push('', `--- Memory lead (${STANCE[r.confidence]}): ${r.name} ---`, r.body.trim(), `--- end lead ---`)
  }
  if (contractText) {
    lines.push('', `--- Unmute operating contract (not auto-loaded in this directory — follow it as written) ---`, contractText.trim(), `--- end contract ---`)
    lines.push(`Act now. Follow the Unmute status-file contract above.`)
  } else {
    lines.push(`Act now. Follow the Unmute status-file contract that is already loaded.`)
  }
  const payload = lines.join('\n')
  const injectedRecipes = nurseryRecipes ?? []
  log.event('dispatch-payload-built', {
    intent,
    statusPath,
    bytes: payload.length,
    nursery: injectedRecipes.length,
    // Calibration extras only — the event itself is kept for everyone.
    ...devFields({
      nurseryNames: injectedRecipes.map(r => r.name),
      nurseryConfidences: injectedRecipes.map(r => r.confidence),
    }),
  })
  return payload
}

/**
 * Built ONLY when resuming a task that did NOT finish (interrupted/killed
 * mid-work). `--continue` restores the session's full prior context, but the REPL
 * comes back idle — so without a nudge it just sits there. This is that nudge: it
 * tells the agent to pick up where it left off and finish, re-grounding it with
 * the original ask + its status path (belt-and-suspenders in case the restored
 * context is thin). NEVER sent to a task that already completed.
 */
export function buildResumeNudge(intent: string, statusPath: string): string {
  return [
    `[Unmute Remote — resumed]`,
    `This task was interrupted before it finished and has just been resumed with your full prior context.`,
    `Pick up exactly where you left off and complete it — do NOT restart from scratch.`,
    `Original request: ${intent}`,
    `Keep updating your status file per the loaded Unmute contract: ${statusPath}`,
    `Continue now.`,
  ].join('\n')
}
