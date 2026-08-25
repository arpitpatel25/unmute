/**
 * What the Agent knows before it is asked.
 *
 * THIS IS THE DIFFERENCE between an Unmute Agent turn and an ordinary harness
 * session. Asked "that thing I was working on yesterday", a plain session can
 * only start searching. The Agent is handed the recently-touched sessions with
 * every turn, so the lookup is usually already done by the time the sentence
 * ends — and when it is not, the digest tells it which ids are worth opening.
 *
 * IT IS A DIGEST, NOT THE INDEX. Every line costs turn context on every single
 * utterance, including "what's on my clipboard". So it is bounded hard, carries
 * one line per session, and points at `sessions_search` for everything it left
 * out. A digest that tried to be the index would make every cheap question pay
 * for the expensive one.
 *
 * PURE — it is handed records and returns a string.
 */
import type { SessionRecord } from './scan'

/**
 * How many sessions the turn is willing to carry.
 *
 * Measured on the real index: 25 entries at 120 characters came to 4,867
 * characters — roughly 1,200 tokens spent on EVERY utterance, including "what
 * is on my clipboard". 15 at 80 lands near 2 KB, which is the most a question
 * that has nothing to do with sessions should be asked to pay. Anything past
 * the cut is one sessions_search away, and the section says so.
 */
export const DIGEST_LIMIT = 15
/** How much of an opening survives into a digest line. */
export const DIGEST_EXCERPT = 80

export interface DigestEntry {
  id: string
  harness: string
  where: string
  ago: string
  opening: string
}

/** Naming a task by its uuid is what the old sessions_list did. */
export interface TaskNames {
  (unmuteTaskId: string): { name?: string; project?: string } | undefined
}

export function relativeAge(from: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - from) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function where(record: SessionRecord, names?: TaskNames): string {
  if (record.unmuteTaskId) {
    const task = names?.(record.unmuteTaskId)
    // The task's own name is what the person calls it. Falling back to the
    // uuid is what made `project` unreadable for every Unmute-started session.
    if (task?.name) return task.name
    if (task?.project) return task.project
    return 'an Unmute session'
  }
  return record.project ?? 'unknown'
}

function truncate(text: string, limit: number): string {
  const points = [...text]
  return points.length <= limit ? text : `${points.slice(0, limit - 1).join('')}…`
}

/**
 * One session may own several transcript files — a resume writes a new one.
 * Showing both spends two digest lines to say one thing, so the newest wins.
 */
function dedupe(records: readonly SessionRecord[]): SessionRecord[] {
  const seen = new Map<string, SessionRecord>()
  for (const record of records) {
    const key = record.unmuteTaskId ?? record.sessionId ?? record.path
    const held = seen.get(key)
    if (!held || record.lastTouchedAt > held.lastTouchedAt) seen.set(key, record)
  }
  return [...seen.values()].sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)
}

export function digestEntries(
  records: readonly SessionRecord[],
  now: number,
  names?: TaskNames,
  limit = DIGEST_LIMIT,
): DigestEntry[] {
  return dedupe(records.filter((record) => !record.derived && record.opening))
    .slice(0, limit)
    .map((record) => ({
      id: record.sessionId ?? record.path,
      harness: record.harness,
      where: where(record, names),
      ago: relativeAge(record.lastTouchedAt, now),
      opening: truncate(record.opening!, DIGEST_EXCERPT),
    }))
}

/**
 * The section injected into a turn. Empty when there is nothing to say — an
 * empty heading is a line of context that teaches the model nothing.
 */
export function digestSection(
  records: readonly SessionRecord[],
  now: number,
  names?: TaskNames,
  limit = DIGEST_LIMIT,
): string {
  const entries = digestEntries(records, now, names, limit)
  if (entries.length === 0) return ''
  const lines = entries.map((entry) => (
    `- ${entry.id} · ${entry.harness} · ${entry.where} · ${entry.ago} · ${entry.opening}`
  ))
  return [
    'Sessions the user has worked in recently, newest first. These are theirs, from every harness,'
    + ' whether or not Unmute started them. Use an id here directly with session_read, session_resume'
    + ' or session_continue_in. This list is the recent ones only — search the rest with'
    + ' sessions_search rather than concluding something does not exist:',
    ...lines,
  ].join('\n')
}
