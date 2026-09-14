import { randomUUID } from 'node:crypto'

import type { RoutineProposal } from './types'

const MAX_PROPOSALS = 5
const MAX_TITLE = 120
const MAX_DETAIL = 2000

/** Matches a fenced block whose info string is exactly `unmute-proposals`
 *  (optionally trailing spaces) — not any fenced block that merely mentions it. */
const FENCE = /```unmute-proposals[ \t]*\n([\s\S]*?)\n```/g

/**
 * §6: a `takes-actions` routine reports proposed actions inline in its final
 * message, in a fenced `unmute-proposals` block, rather than performing them.
 * This lifts that block out of the result text (which is what the user
 * actually reads) and turns it into `RoutineProposal`s the user can approve.
 *
 * A model can restate or correct its own block mid-message, so only the LAST
 * one counts. Anything that fails to parse as JSON is left exactly where it
 * was — the text is the model's real answer, and a malformed block should
 * not vanish silently along with it.
 */
export function liftProposals(text: string, makeId: () => string = randomUUID): { text: string; proposals: RoutineProposal[] } {
  let match: RegExpExecArray | null = null
  const re = new RegExp(FENCE.source, 'g')
  for (let m = re.exec(text); m; m = re.exec(text)) match = m

  if (!match) return { text, proposals: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return { text, proposals: [] }
  }
  if (!Array.isArray(parsed)) return { text, proposals: [] }

  const proposals: RoutineProposal[] = []
  for (const item of parsed) {
    if (proposals.length >= MAX_PROPOSALS) break
    if (!item || typeof item !== 'object') continue
    const title = (item as Record<string, unknown>).title
    const detail = (item as Record<string, unknown>).detail
    if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE) continue
    if (typeof detail !== 'string' || !detail.trim() || detail.length > MAX_DETAIL) continue
    proposals.push({ id: makeId(), title, detail, state: 'open' })
  }

  const lifted = text.slice(0, match.index) + text.slice(match.index + match[0].length)
  return { text: lifted.trim(), proposals }
}
