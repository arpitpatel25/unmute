/**
 * The record: a file, not a tool.
 *
 * WHY A FILE. `sessions_list`, `sessions_search` and `session_read` were three
 * MCP tools over data the Agent can already open — plaintext JSON on the same
 * disk, with `Read`, `Glob` and `Grep` already in its allowlist. A tool over
 * readable data caps the Agent at the queries whoever wrote the schema
 * imagined: `sessions_search(query: string)` cannot express "everything in
 * unmute-cloud from Tuesday that mentions the notch", which is one grep. That
 * is the deleted-regex lesson one layer up — deciding in advance how an
 * intelligent model is allowed to interrogate its own data.
 *
 * WHY NOT INJECTED. The record used to be a fifteen-line digest pasted above
 * every request. It cost 400–500 tokens on turns that had nothing to do with
 * sessions, and it biased the model toward thinking about them — the same
 * failure as the preamble that caused the 25 August refusal, where text near
 * the question beat text far from it. And it stops fitting the moment the
 * summaries get good, which is the point of the summaries.
 *
 * SO IT IS SHAPED TO BE READ WHOLE. One block per session, newest first,
 * grouped by date, with the vocabulary a person would actually search by. One
 * `Read` is normally the entire lookup, which is what answers the round-trip
 * objection to files-over-tools.
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

import type { StoredSession } from './store'

/** Where the record lives, so the constitution can name one path. */
export function defaultRecordPath(agentRoot: string): string {
  return join(agentRoot, 'sessions', 'recent-sessions.md')
}

function dateOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

function dayLabel(date: string, todayDate: string, yesterdayDate: string): string {
  if (date === todayDate) return `${date} — today`
  if (date === yesterdayDate) return `${date} — yesterday`
  return date
}

/** One session, as a block someone can read and grep. */
export function renderSession(session: StoredSession): string {
  const where = session.project
    ?? (session.unmuteTaskId ? `unmute task ${session.unmuteTaskId.slice(0, 8)}` : 'unknown')
  const lines = [
    `- ${session.summary.about || session.opening || 'Untitled session'}`,
    `  id: ${session.sessionId ?? session.path}`,
    `  where: ${where} · ${session.harness}`,
  ]
  if (session.summary.standing) lines.push(`  standing: ${session.summary.standing}`)
  if (session.summary.done.length > 0) {
    lines.push('  done:')
    for (const item of session.summary.done) lines.push(`    - ${item}`)
  }
  if (session.summary.touched.length > 0) {
    lines.push(`  touched: ${session.summary.touched.join(', ')}`)
  }
  // Honest about its own coverage: a partial summary has not caught up with the
  // transcript, and the Agent should open the file rather than trust this.
  if (session.partial) lines.push('  note: summary is partial — read the transcript for detail')
  lines.push(`  transcript: ${session.path}`)
  return lines.join('\n')
}

export interface RenderOptions {
  now: number
  /** Sessions newer than this are in the record. */
  windowMs?: number
}

export function renderRecord(
  sessions: readonly StoredSession[],
  options: RenderOptions,
): string {
  const windowMs = options.windowMs ?? 5 * 86_400_000
  const cutoff = options.now - windowMs
  const inWindow = sessions
    .filter((s) => s.lastTouchedAt >= cutoff)
    .sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)

  const today = dateOf(options.now)
  const yesterday = dateOf(options.now - 86_400_000)

  const header = [
    '# Recent sessions',
    '',
    'Every coding session on this machine, newest first — Claude Code and Codex',
    'alike, the ones Unmute started and the ones run in a terminal. Written by',
    'Unmute; do not edit. Sessions nobody talked to (subagent forks, plan',
    'workers, Unmute\'s own jobs) are deliberately absent.',
    '',
    `Covering ${Math.round(windowMs / 86_400_000)} days. Older work is not here and is not gone —`,
    'search this directory, and failing that the transcripts themselves.',
    '',
  ]
  if (inWindow.length === 0) {
    return [...header, '_Nothing in this window._', ''].join('\n')
  }

  const out = [...header]
  let currentDay = ''
  for (const session of inWindow) {
    const day = dateOf(session.lastTouchedAt)
    if (day !== currentDay) {
      currentDay = day
      out.push(`## ${dayLabel(day, today, yesterday)}`, '')
    }
    out.push(renderSession(session), '')
  }
  return out.join('\n')
}

/** Write the record where the constitution says it is. */
export async function writeRecord(
  path: string,
  sessions: readonly StoredSession[],
  options: RenderOptions,
): Promise<void> {
  const body = renderRecord(sessions, options)
  const staging = `${path}.tmp`
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await fs.writeFile(staging, body, { mode: 0o600 })
  await fs.rename(staging, path)
}
