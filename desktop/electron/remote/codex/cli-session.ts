/**
 * CODEX CLI — finding the rollout a task is writing to.
 *
 * `cli-observer.ts` maps rollout events onto task state. This finds the file.
 *
 * WHERE THEY LIVE (verified 2026-08-09, codex-cli 0.142.5):
 *
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl    live
 *   ~/.codex/archived_sessions/rollout-<ts>-<uuid>.jsonl      archived
 *
 * Both are searched, because a session archived mid-task must not become
 * unreadable — the task would freeze on its last known state with nothing
 * logged, which is the failure mode this whole layer exists to avoid.
 *
 * THE SESSION ID IS DISCOVERED, NOT ASSIGNED. Claude takes `--session-id` so we
 * mint the id and know it before the process starts. Codex mints its own, so a
 * fresh task has no id until Codex writes one — and the only way to learn it is
 * to look for the rollout that appeared after we spawned, in the directory we
 * spawned into.
 *
 * That is a race with exactly one safe resolution: match on BOTH the working
 * directory AND a start time at-or-after our spawn. Matching on cwd alone would
 * adopt whichever session the user happened to have open in that repo — someone
 * else's conversation, silently, and then write our task's state from it.
 *
 * ORIGINATOR IS NOT USED AS A FILTER, deliberately. `session_meta.originator`
 * does distinguish "Codex Desktop" from a CLI run, and filtering on it looks
 * tempting. But the value is Codex's to change, an unrecognised string would
 * make every task undiscoverable, and the cwd+time match is already precise.
 * It is read and logged so a mismatch is visible if this ever goes wrong.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createLogger } from '../log'
import type { RolloutEvent } from './cli-observer'

const log = createLogger('codex-cli-session')

const ROLLOUT = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/i

function roots(home = homedir()): string[] {
  return [join(home, '.codex', 'sessions'), join(home, '.codex', 'archived_sessions')]
}

/** Every rollout on disk, newest first. Walks the date-partitioned tree. */
async function allRollouts(home?: string): Promise<Array<{ path: string; sessionId: string; mtimeMs: number }>> {
  const out: Array<{ path: string; sessionId: string; mtimeMs: number }> = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { await walk(p, depth + 1); continue }
      const m = ROLLOUT.exec(e.name)
      if (!m) continue
      try {
        const st = await fs.stat(p)
        out.push({ path: p, sessionId: m[1], mtimeMs: st.mtimeMs })
      } catch { /* vanished between readdir and stat */ }
    }
  }
  for (const r of roots(home)) await walk(r, 0)
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/** The rollout for a known session id, live or archived. */
export async function findRollout(sessionId: string, home?: string): Promise<string | null> {
  const all = await allRollouts(home)
  return all.find((r) => r.sessionId === sessionId)?.path ?? null
}

/** Parse a rollout into events. Tolerant: a half-written trailing line is
 *  normal — Codex is appending to this file as we read it. */
export async function readRolloutEvents(path: string): Promise<RolloutEvent[]> {
  let text: string
  try { text = await fs.readFile(path, 'utf8') } catch { return [] }
  const out: RolloutEvent[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line) as RolloutEvent) } catch { /* mid-write tail */ }
  }
  return out
}

/**
 * Which session did the task we just spawned become?
 *
 * Matches on cwd AND a start at-or-after our spawn. Both are required: cwd
 * alone would adopt whatever conversation the user already had open in that
 * repo and then report our task's state from someone else's session.
 *
 * `sinceMs` is given a small grace, because the rollout's own timestamp is
 * written when Codex boots rather than when we called spawn, and a clock that
 * rounds the wrong way would make the session we are looking for invisible
 * forever.
 */
export async function discoverSessionId(
  cwd: string, sinceMs: number, home?: string, graceMs = 5_000,
): Promise<string | null> {
  for (const r of await allRollouts(home)) {
    if (r.mtimeMs + graceMs < sinceMs) break        // sorted newest-first: older still
    const events = await readRolloutEvents(r.path)
    const meta = events.find((e) => e.type === 'session_meta')?.payload as
      { cwd?: string; session_id?: string; timestamp?: string; originator?: string } | undefined
    if (!meta?.cwd || meta.cwd !== cwd) continue
    const started = meta.timestamp ? Date.parse(meta.timestamp) : r.mtimeMs
    if (started + graceMs < sinceMs) continue
    log.event('codex-cli-session-discovered', {
      sessionId: r.sessionId, cwd, originator: meta.originator ?? null,
    })
    return meta.session_id ?? r.sessionId
  }
  return null
}
