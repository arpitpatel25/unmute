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

const log = createLogger('dispatch-prompt')

export interface DispatchInput {
  /** The cleaned intent string (post intent-cleanup, PRD §13.7). */
  intent: string
  /** Absolute path of THIS task's status file (Unmute-owned, PRD §6.1). */
  statusPath: string
  /** Absolute path of THIS task's recipe-suggestion scratch file (PRD §8.1). */
  recipeScratchPath?: string
}

/**
 * Build the exact text typed into the REPL's stdin to dispatch one task.
 * Short by construction — the full contract is already loaded (decision #3).
 */
export function buildDispatch({ intent, statusPath, recipeScratchPath }: DispatchInput): string {
  const lines = [
    `[Unmute Remote task]`,
    `Task: ${intent}`,
    `Status file (yours to update per the loaded Unmute contract): ${statusPath}`,
  ]
  if (recipeScratchPath) {
    lines.push(`Recipe-suggestion scratch file (write a suggestion here only if you learned a better/repeatable way): ${recipeScratchPath}`)
  }
  lines.push(`Act now. Follow the Unmute status-file contract that is already loaded.`)
  const payload = lines.join('\n')
  log.event('dispatch-payload-built', { intent, statusPath, bytes: payload.length })
  return payload
}
