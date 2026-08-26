/**
 * The session record: what Unmute knows about the user's own work.
 *
 * NOT IN THE ENCRYPTED MEMORY STORE, deliberately. Memory holds what the user
 * authored and asked to keep; this derives entirely from transcripts sitting in
 * plaintext on the same disk. Encrypting a projection of readable data buys
 * nothing and couples two lifecycles that must fail separately — a corrupt
 * record has to be deletable without putting a single memory at risk. Deleting
 * this file costs one rescan.
 *
 * THE WINDOW BOUNDS GENERATION, NOT RETENTION. Sessions touched inside the
 * window get their summaries brought up to date. Summaries already written are
 * kept FOREVER: a few hundred bytes each, and deleting one throws away work
 * already paid for. So "that thing three weeks ago" is answered instantly from
 * a summary written when it was fresh, and the full-disk fallback becomes rare
 * rather than the normal path for anything over a week old.
 *
 * A CURSOR IS PER CONVERSATION, NOT PER FILE. Keyed by the harness's own
 * session id where it states one — the same reasoning as curator.ts's convKey,
 * so a resumed conversation advances one cursor rather than forking a second.
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Harness } from '../../transcript'
import {
  type DiscoveredSession, type SessionRoots,
  defaultRoots, discoverSessions, identify, probeSession, readTurnsSince,
} from './scan'
import {
  type RunModel, type SessionSummary, emptySummary, updateSummary,
} from './summary'

const CACHE_VERSION = 2
/**
 * NO CAP ON A FIRST READ. Deliberately.
 *
 * A cap bought a faster cold start — 100 seconds down to 0.7 — by stopping at
 * a byte count and marking the summary partial. But a partial summary is a GAP:
 * a session whose middle was never read, in a record whose whole job is to say
 * what happened. The speed was real and the gap was worse, so the transcript is
 * read whole, once, and the cost is one slow background pass on first launch
 * that nothing waits on.
 *
 * What still bounds it: the probe below skips machine-issued sessions before a
 * byte of them is read, and every read after the first is a delta of a few
 * turns. Measured on the real corpus: 155 of 256 skipped outright, and the 101
 * that remain are read exactly once, ever.
 */
export const FIRST_PASS_BYTES = Number.POSITIVE_INFINITY
/**
 * How many sessions are summarised at once.
 *
 * The bound is not about serving many users — there is one. It is that every
 * summary spawns a WHOLE CLI PROCESS: a `claude -p` or `codex exec` holding its
 * own model connection. Running all of them at once would thrash the machine
 * and hit the user's own rate limit, so this is finite for the same reason a
 * build is `-j5` rather than `-j∞`. It is a PARALLELISM limit and not a quota:
 * every eligible session is still processed, five at a time, until none remain.
 */
export const REFRESH_CONCURRENCY = 5

export interface StoredSession {
  key: string
  path: string
  harness: Harness
  sessionId?: string
  cwd?: string
  project?: string
  unmuteTaskId?: string
  lastTouchedAt: number
  /** Line the next read resumes from. Advanced only when a summary succeeded. */
  cursor: number
  userTurns: number
  opening?: string
  summary: SessionSummary
  /** True while a byte-capped first pass has not caught up. */
  partial: boolean
  updatedAt: number
}

interface CacheFile {
  version: number
  sessions: Record<string, StoredSession>
}

export function conversationKey(
  found: Pick<DiscoveredSession, 'path'>,
  sessionId?: string,
): string {
  return sessionId ?? found.path
}

export interface SessionStoreOptions {
  cachePath: string
  roots?: SessionRoots
  now?: () => number
  /** How far back sessions are brought up to date. Retention is unbounded. */
  windowMs?: number
  concurrency?: number
  firstPassBytes?: number
}

export function defaultCachePath(agentRoot: string): string {
  return join(agentRoot, 'sessions', 'record.json')
}

export class SessionStore {
  private sessions = new Map<string, StoredSession>()
  private loaded = false
  private readonly now: () => number

  constructor(private readonly options: SessionStoreOptions) {
    this.now = options.now ?? Date.now
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await fs.readFile(this.options.cachePath, 'utf8')
      const parsed = JSON.parse(raw) as CacheFile
      // A record written by an older shape is a cold start, never an error —
      // everything in it is reconstructible from disk.
      if (parsed?.version === CACHE_VERSION && parsed.sessions) {
        for (const [key, value] of Object.entries(parsed.sessions)) {
          if (value && typeof value === 'object') this.sessions.set(key, value)
        }
      }
    } catch { /* absent or corrupt — rescan */ }
  }

  async save(): Promise<void> {
    const payload: CacheFile = {
      version: CACHE_VERSION,
      sessions: Object.fromEntries(this.sessions),
    }
    const staging = `${this.options.cachePath}.tmp`
    await fs.mkdir(dirname(this.options.cachePath), { recursive: true, mode: 0o700 })
    await fs.writeFile(staging, JSON.stringify(payload), { mode: 0o600 })
    await fs.rename(staging, this.options.cachePath)
  }

  all(): StoredSession[] {
    return [...this.sessions.values()].sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)
  }

  /** Sessions touched since `since`, newest first. */
  since(since: number): StoredSession[] {
    return this.all().filter((s) => s.lastTouchedAt >= since)
  }

  find(id: string): StoredSession | undefined {
    return this.sessions.get(id)
      ?? this.all().find((s) => s.sessionId === id || s.unmuteTaskId === id || s.path === id)
  }

  /**
   * Bring one session's summary up to date.
   *
   * THE CURSOR ADVANCES ONLY ON SUCCESS. A failed model call that advanced it
   * would drop those turns forever and leave a permanent hole in the record —
   * so a failure costs a retry on the next sweep and nothing else.
   */
  async updateOne(
    found: DiscoveredSession,
    run: RunModel,
    parseJson: (raw: string) => unknown,
  ): Promise<'updated' | 'skipped' | 'failed' | 'unchanged'> {
    await this.load()
    const probe = await probeSession(found)
    if (probe.derived) return 'skipped'

    const key = conversationKey(found, probe.sessionId)
    const prior = this.sessions.get(key)
    const cursor = prior?.cursor ?? 0
    const firstPass = cursor === 0

    const batch = await readTurnsSince(found, {
      fromLine: cursor,
      ...(firstPass ? { maxBytes: this.options.firstPassBytes ?? FIRST_PASS_BYTES } : {}),
    })
    if (batch.turns.length === 0) {
      if (prior) {
        prior.lastTouchedAt = found.lastTouchedAt
        return 'unchanged'
      }
      return 'skipped'
    }

    const facts = identify(batch)
    const result = await updateSummary(
      prior?.summary ?? emptySummary(),
      batch.turns,
      run,
      parseJson,
    )
    if (!result.ok) return 'failed'

    this.sessions.set(key, {
      key,
      path: found.path,
      harness: found.harness,
      ...(facts.sessionId ? { sessionId: facts.sessionId } : {}),
      ...(facts.cwd ? { cwd: facts.cwd } : {}),
      ...(facts.project ? { project: facts.project } : {}),
      ...(facts.unmuteTaskId ? { unmuteTaskId: facts.unmuteTaskId } : {}),
      lastTouchedAt: found.lastTouchedAt,
      cursor: batch.newOffset,
      userTurns: (prior?.userTurns ?? 0) + facts.userTurns,
      ...(prior?.opening ?? facts.opening ? { opening: prior?.opening ?? facts.opening } : {}),
      summary: result.summary,
      partial: batch.capped,
      updatedAt: this.now(),
    })
    return 'updated'
  }

  /**
   * Bring every session inside the window up to date.
   *
   * Sessions outside it keep whatever summary they already have — the window is
   * about what gets WRITTEN, never about what is kept.
   */
  async refresh(
    run: RunModel,
    parseJson: (raw: string) => unknown,
    options: { signal?: { aborted: boolean }; idleMs?: number } = {},
  ): Promise<{ updated: number; skipped: number; failed: number; unchanged: number }> {
    await this.load()
    const windowMs = this.options.windowMs ?? 5 * 86_400_000
    const roots = this.options.roots ?? defaultRoots()
    const cutoff = this.now() - windowMs
    // A session still being typed into has no coherent state to record, so it
    // is left for the next pass rather than summarised mid-turn.
    //
    // Applied only when asked for. A zero idle window must mean "no gate at
    // all", never "must be older than the instant I captured a moment ago" —
    // a file written microseconds earlier can carry an mtime past that, and
    // would then be skipped forever by clock skew alone.
    const idleMs = options.idleMs ?? 0
    const idleBefore = idleMs > 0 ? this.now() - idleMs : Number.POSITIVE_INFINITY
    const found = (await discoverSessions(roots))
      .filter((s) => s.lastTouchedAt >= cutoff && s.lastTouchedAt <= idleBefore)

    const tally = { updated: 0, skipped: 0, failed: 0, unchanged: 0 }
    const limit = Math.max(1, this.options.concurrency ?? REFRESH_CONCURRENCY)
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(limit, found.length) }, async () => {
      for (;;) {
        if (options.signal?.aborted) return
        const next = cursor++
        if (next >= found.length) return
        try {
          tally[await this.updateOne(found[next]!, run, parseJson)] += 1
        } catch {
          tally.failed += 1
        }
      }
    }))
    await this.save()
    return tally
  }
}
