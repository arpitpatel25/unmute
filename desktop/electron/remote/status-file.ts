// Unmute Remote — status file: the frozen wire protocol (PRD §6.1).
//
// Schema authored in docs/superpowers/plans/2026-06-16-remote-status-schema.md
// (PENDING sign-off — this is the one artifact the owner wants eyes on).
//
// This module is Unmute's READ side of the contract:
//   * scaffoldStatusFile() — Unmute creates the file + owns the path; Claude
//     only fills fields (PRD ownership decision). Unmute writes ONLY the
//     initial scaffold; after that it never edits the content.
//   * readStatus()         — atomic-tolerant read (PRD #2): missing/partial/
//     invalid ⇒ null ("no update this poll"), never throws.
//   * isStale()            — mtime-based staleness backstop (PRD §6.3). This is
//     TUI-INDEPENDENT and the load-bearing stuck-detector; terminal-silence is
//     only a bonus hint we may add later.
//
// Claude's WRITE side (atomic temp-then-rename + heartbeat cadence) is
// instructed via contract/contract.md, not enforced here.

import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { createLogger } from './log'

const log = createLogger('status-file')

// ─── Schema types (mirror the schema doc 1:1) ──────────────────────

export type TaskState = 'processing' | 'needs-user' | 'ready' | 'done' | 'failed' // PRD §5.3 + ready (ball-with-user checkpoint)

// The executor self-classifies the task so Unmute can drive presentation +
// lifecycle (DECIDED). The executor knows best — it's the one doing the work.
//   info     — a fetch/answer; the deliverable is TEXT → show the full `detail`.
//   navigate — open/land the user on something (page, tab, app) → focus it.
//   watch    — start VIDEO the user wants to watch (YouTube, Netflix, an OTT
//              show) → focus the tab so they land on it, then detach glow-free;
//              the tab keeps playing.
//   consume  — start AUDIO to listen to in the background (music, podcast) →
//              detach glow-free WITHOUT stealing focus; the tab keeps playing.
//   act      — an action/edit with a side effect → keep warm for a follow-up.
export type TaskCategory = 'info' | 'navigate' | 'watch' | 'consume' | 'act'

export interface TaskResult {
  summary: string
  detail?: string
  artifacts?: Array<{ type: 'path' | 'url'; value: string }>
}

export interface TaskError {
  reason: string
  detail?: string
}

export interface TaskQuestion {
  text: string
  /**
   * `terminal_only` is a REFUSAL, and the only kind that offers the user no way
   * to reply from the card. It means a picker is open in the session that we
   * have not proven we can drive, so the card shows the whole ask and the
   * terminal underneath takes the answer. Every other kind invites a reply that
   * Unmute promises to deliver; this one promises the opposite, out loud.
   */
  kind?: 'free_text' | 'choice' | 'confirm' | 'terminal_only'
  choices?: string[]
  irreversible?: boolean // PRD §10.7 destructive-action confirm
}

export interface RecipeSuggestionPointer {
  present: boolean
  scratch_path?: string
}

export interface StatusPayload {
  schema_version?: number
  state: TaskState
  updated_at?: string
  step?: string
  /** Executor self-classification (drives presentation + lifecycle). */
  category?: TaskCategory
  result?: TaskResult
  error?: TaskError
  question?: TaskQuestion
  recipe_suggestion?: RecipeSuggestionPointer
  /** Rolling re-entry summary (2-3 sentences), refreshed on every write — the
   *  warm-up that kills the human's cold restart. Display-framed as "where you
   *  left off", never as authoritative truth. */
  thread_context?: string
}

export const CURRENT_SCHEMA_VERSION = 1

// ─── Scaffold (Unmute owns creation + path; Claude fills fields) ────

/**
 * Create the initial status file. Unmute writes ONLY this scaffold; from here
 * on Claude is the sole writer of content and Unmute is read-only (PRD §6.1).
 */
export async function scaffoldStatusFile(filePath: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true })
  const initial: StatusPayload = {
    schema_version: CURRENT_SCHEMA_VERSION,
    state: 'processing',
    updated_at: new Date().toISOString(),
  }
  await fs.writeFile(filePath, JSON.stringify(initial, null, 2), 'utf8')
  log.event('status-file-scaffolded', { filePath, state: 'processing' })
}

/**
 * Write a status payload ATOMICALLY (temp file, then rename).
 *
 * This is the observer's write path (observer.ts) — and it is the same atomic
 * dance the operating contract used to spend six lines instructing the model to
 * perform by hand. Doing it in our own code is not merely tidier: a model can
 * forget the rename, emit malformed JSON, or be interrupted mid-write, and all
 * three produced the "caught mid-write, retry next poll" class of bug that
 * readStatus() below exists to tolerate. Here it simply cannot happen.
 *
 * Returns false rather than throwing — a failed status write must never take
 * down the task it was describing.
 */
export async function writeStatusFile(filePath: string, payload: StatusPayload): Promise<boolean> {
  const tmp = `${filePath}.tmp`
  try {
    await fs.mkdir(dirname(filePath), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await fs.rename(tmp, filePath)
    return true
  } catch (e) {
    log.warn('status write failed', { filePath, error: (e as Error).message })
    try { await fs.rm(tmp, { force: true }) } catch { /* best effort */ }
    return false
  }
}

// ─── Tolerant read (PRD #2) ─────────────────────────────────────────

function isValidState(s: unknown): s is TaskState {
  return s === 'processing' || s === 'needs-user' || s === 'ready' || s === 'done' || s === 'failed'
}

/**
 * Read + parse the status file. Returns null on ANY problem (missing, partial
 * write caught mid-rename, invalid JSON, missing/invalid `state`) — the caller
 * simply retries on the next poll. Never throws (PRD #2 tolerant reader).
 */
export async function readStatus(filePath: string): Promise<StatusPayload | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch {
    return null // not there yet / transient — no update this poll
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Almost always a read that landed mid-write. Expected; debug not warn.
    log.debug('status read parse-miss (likely mid-write) — will retry', { filePath })
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || !isValidState((parsed as StatusPayload).state)) {
    log.debug('status read missing/invalid state — treated as no-update', { filePath })
    return null
  }
  return parsed as StatusPayload
}

// ─── Staleness backstop (PRD §6.3 — mtime, TUI-independent) ─────────

/**
 * Decide whether a task looks STUCK.
 *
 * ONLY a `processing` task can go stale. A task that is actively working but
 * stops touching its status file for `thresholdMs` is likely hung → flag it.
 *
 * Crucially, `needs-user` is NOT stale-able: that task is *legitimately* waiting
 * on the human, who may take minutes (or step away). Its own `needs-user` state
 * is already the "needs attention" signal (amber row) — flagging it "stuck" on
 * top of that is wrong and was a real bug (a Gmail-auth pause got marked stuck
 * after 4 min just because the user hadn't answered yet). `done`/`failed`/
 * `stuck` are likewise never stale.
 *
 * Keying on the file's mtime (not terminal output) is what makes this immune
 * to whatever the Claude TUI does on screen (PRD §6.3).
 */
export function isStale(
  status: Pick<StatusPayload, 'state'>,
  mtimeMs: number,
  nowMs: number,
  thresholdMs: number,
): boolean {
  // Only an actively-working task can hang. Anything waiting on the user, or
  // already terminal, is never "stuck".
  if (status.state !== 'processing') return false
  const ageMs = nowMs - mtimeMs
  const stale = ageMs > thresholdMs
  if (stale) {
    log.event('staleness-detected', { state: status.state, ageMs, thresholdMs })
  }
  return stale
}

/** Read the file's last-modified time in ms, or null if unreadable. */
export async function statusMtimeMs(filePath: string): Promise<number | null> {
  try {
    const st = await fs.stat(filePath)
    return st.mtimeMs
  } catch {
    return null
  }
}
