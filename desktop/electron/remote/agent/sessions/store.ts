/**
 * The session index: a cache over what is already on disk.
 *
 * NOT IN THE ENCRYPTED MEMORY STORE, and that is deliberate. Memory holds what
 * the user authored and asked to keep; this derives entirely from transcripts
 * sitting in plaintext on the same disk. Encrypting a projection of public-on-
 * disk data buys nothing and couples two lifecycles that must be able to fail
 * separately — a corrupt index has to be deletable without putting a single
 * user memory at risk. Deleting this file costs one rescan and nothing else.
 *
 * KEYED BY (path, mtime), so a session is read once per change and never again.
 * Discovery over 1,061 real transcripts costs 85ms and touches no contents;
 * only the ones whose mtime moved are re-read. That is what makes a cold start
 * affordable without a background sweeper.
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  type DiscoveredSession, type SessionRecord, type SessionRoots,
  defaultRoots, discoverSessions, readSession,
} from './scan'

const CACHE_VERSION = 1

interface CacheFile {
  version: number
  records: Record<string, SessionRecord>
}

function key(found: Pick<DiscoveredSession, 'path' | 'lastTouchedAt'>): string {
  return `${found.path}@${found.lastTouchedAt}`
}

export interface SessionIndexOptions {
  /** Where the cache file lives. */
  cachePath: string
  roots?: SessionRoots
  now?: () => number
  /** How many transcripts to read at once on a refresh. */
  concurrency?: number
}

export class SessionIndex {
  private records = new Map<string, SessionRecord>()
  private readonly now: () => number
  private readonly roots: SessionRoots
  private readonly concurrency: number
  private loaded = false

  constructor(private readonly options: SessionIndexOptions) {
    this.now = options.now ?? Date.now
    this.roots = options.roots ?? defaultRoots()
    this.concurrency = Math.max(1, options.concurrency ?? 8)
  }

  /** A missing or unreadable cache is a cold start, never an error. */
  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await fs.readFile(this.options.cachePath, 'utf8')) as CacheFile
      if (raw?.version !== CACHE_VERSION || !raw.records) return
      for (const [id, record] of Object.entries(raw.records)) this.records.set(id, record)
    } catch { /* cold start */ }
  }

  private async persist(): Promise<void> {
    const payload: CacheFile = { version: CACHE_VERSION, records: Object.fromEntries(this.records) }
    const target = this.options.cachePath
    const staging = `${target}.tmp`
    try {
      await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await fs.writeFile(staging, JSON.stringify(payload), { mode: 0o600 })
      await fs.rename(staging, target)
    } catch { /* an index that cannot be saved is still usable in memory */ }
  }

  /**
   * Bring the index level with the disk.
   *
   * `within` bounds how far back to READ, not how far back to know: everything
   * already cached stays queryable however old it is. A cold start therefore
   * costs the recent tier, and the rest fills in as it is touched.
   */
  async refresh(withinMs = 72 * 3_600_000): Promise<SessionRecord[]> {
    await this.load()
    const found = await discoverSessions(this.roots)
    const live = new Set(found.map(key))
    // Drop entries whose file is gone or whose mtime moved on.
    for (const id of [...this.records.keys()]) if (!live.has(id)) this.records.delete(id)

    const cutoff = this.now() - withinMs
    const stale = found.filter((entry) => (
      entry.lastTouchedAt >= cutoff && !this.records.has(key(entry))
    ))
    for (let at = 0; at < stale.length; at += this.concurrency) {
      const batch = stale.slice(at, at + this.concurrency)
      const read = await Promise.all(batch.map(async (entry) => {
        try { return await readSession(entry) } catch { return null }
      }))
      for (const record of read) if (record) this.records.set(key(record), record)
    }
    if (stale.length > 0) await this.persist()
    return this.all()
  }

  all(): SessionRecord[] {
    return [...this.records.values()].sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)
  }

  /** Everything touched inside the window, newest first. */
  recent(withinMs: number): SessionRecord[] {
    const cutoff = this.now() - withinMs
    return this.all().filter((record) => record.lastTouchedAt >= cutoff)
  }

  find(id: string): SessionRecord | undefined {
    return this.all().find((record) => record.sessionId === id
      || record.unmuteTaskId === id
      || record.path === id)
  }

  /**
   * Reads a session in full, on demand.
   *
   * Deliberately not part of refresh: opening a transcript is what you do
   * because you need what is inside it, not to find out whether you do.
   */
  async readFull(id: string, maxBytes = 512 * 1024): Promise<string | null> {
    const record = this.find(id)
    if (!record) return null
    try {
      const handle = await fs.open(record.path, 'r')
      try {
        const length = Math.min(maxBytes, record.sizeBytes)
        const buffer = Buffer.alloc(length)
        const from = Math.max(0, record.sizeBytes - length)
        const { bytesRead } = await handle.read(buffer, 0, length, from)
        return buffer.subarray(0, bytesRead).toString('utf8')
      } finally { await handle.close() }
    } catch { return null }
  }
}

export function defaultCachePath(agentRoot: string): string {
  return join(agentRoot, 'sessions', 'index.json')
}
