// Unmute Remote — the group registry: the durable vocabulary of streams.
//
// THE REVERSAL (2026-08-27). Spec 2026-07-16-cockpit-grouping §2 said "live
// groups only — the screen is the entire state. No registry, no history, no
// decay", and accepted the consequence explicitly: "a stream that briefly
// empties may get a fresh name later — rare... and correct when it happens."
//
// It is not rare. That single rule is why the wall grew "unmute", "unmute
// cloud" and "unmute AI" for one stream: the router is shown the groups on
// screen and told those are the only ones that exist, so every time a stream
// went quiet its name was minted again from scratch.
//
// This module is the fix, and it is a PREVENTION, not a cleanup. Nothing here
// re-groups anything on a timer — there is deliberately no reconciliation pass
// (see §"Ruled out" in the design doc). A task is grouped once, by the router,
// against a vocabulary that no longer evaporates; after that only the user
// moves it. Assign-once (§5 of that spec) is untouched and now more true than
// before, because nothing exists that could reshuffle.
//
// Identity is groupKey (group-key.ts), never the raw label: it is what makes
// the SECOND "Unmute" resolve to the FIRST "unmute" instead of forking.
//
// Injectable path + clock + id factory, so the whole thing is unit-testable
// without electron — same discipline as runtime-config and skill-usage. It
// follows skill-usage's ownership rule too: this is an Unmute-owned sidecar in
// ~/.unmute/remote, never a file in the user's own territory.

import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { groupKey } from './group-key'
import { createLogger } from './log'

const log = createLogger('group-registry')

/** Longest label we keep. Matches the cap `setGroup` has always applied — a
 *  section header, not a sentence. */
export const MAX_GROUP_LABEL = 32

export interface GroupEntry {
  /** Stable identity. Tasks point at THIS, never at the label — which is what
   *  makes a rename a one-field write instead of a walk over every task, and
   *  what stops a rename from orphaning tasks that are not currently loaded. */
  id: string
  /** What the user sees. Whatever was first written for this stream. */
  label: string
  /** groupKey(label) — the comparison identity. Derived, stored for lookup. */
  key: string
  /** 'user' entries are authored deliberately and are never pruned. */
  source: 'user' | 'auto'
  createdAt: number
  lastSeenAt: number
}

interface RegistryFile {
  version: 1
  entries: GroupEntry[]
}

export interface GroupRegistryOpts {
  path: string
  now?: () => number
  idFactory?: () => string
}

export class GroupRegistry {
  private byId = new Map<string, GroupEntry>()
  private byKey = new Map<string, GroupEntry>()
  private readonly now: () => number
  private readonly newId: () => string
  private writing: Promise<void> | null = null
  private dirty = false

  constructor(private readonly opts: GroupRegistryOpts) {
    this.now = opts.now ?? Date.now
    this.newId = opts.idFactory ?? randomUUID
  }

  /** Read the sidecar. A missing or unreadable file is an EMPTY registry, never
   *  a throw: grouping is metadata, and it must not be able to stop a launch. */
  async load(): Promise<void> {
    let parsed: RegistryFile | null = null
    try {
      parsed = JSON.parse(await fs.readFile(this.opts.path, 'utf8')) as RegistryFile
    } catch {
      parsed = null
    }
    this.byId.clear()
    this.byKey.clear()
    for (const raw of parsed?.entries ?? []) {
      if (!raw || typeof raw.id !== 'string' || typeof raw.label !== 'string') continue
      // Re-derive the key on read rather than trusting the file: if the folding
      // rules in group-key ever tighten, an old file converges to the new rule
      // instead of keeping two entries that today would be one.
      const key = groupKey(raw.label)
      if (!key) continue
      const entry: GroupEntry = {
        id: raw.id,
        label: raw.label,
        key,
        source: raw.source === 'user' ? 'user' : 'auto',
        createdAt: Number(raw.createdAt) || this.now(),
        lastSeenAt: Number(raw.lastSeenAt) || Number(raw.createdAt) || this.now(),
      }
      const clash = this.byKey.get(key)
      if (clash) {
        // Two file entries folding to one key: keep the user-authored one, else
        // the older. This is where a pre-registry duplicate pair collapses on
        // first launch, with no model involved.
        if (clash.source === 'user' || clash.createdAt <= entry.createdAt) continue
        this.byId.delete(clash.id)
      }
      this.byId.set(entry.id, entry)
      this.byKey.set(key, entry)
    }
  }

  list(): GroupEntry[] {
    return [...this.byId.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  get(id: string | null | undefined): GroupEntry | undefined {
    return id ? this.byId.get(id) : undefined
  }

  /** Look up WITHOUT minting. Used where an unknown label should stay unknown. */
  find(label: string | null | undefined): GroupEntry | undefined {
    const key = groupKey(label)
    return key ? this.byKey.get(key) : undefined
  }

  /**
   * Find-or-mint. The router path: a label that names a stream we already know
   * JOINS it; anything else creates one. A blank label is not a stream and
   * mints nothing.
   */
  resolve(label: string | null | undefined, opts: { source?: 'user' | 'auto' } = {}): GroupEntry | undefined {
    const trimmed = (label ?? '').trim().slice(0, MAX_GROUP_LABEL)
    const key = groupKey(trimmed)
    if (!key) return undefined
    const found = this.byKey.get(key)
    if (found) {
      // A stream the user names explicitly is promoted — it stops being a guess.
      if (opts.source === 'user' && found.source !== 'user') {
        found.source = 'user'
        this.dirty = true
      }
      this.touch(found.id)
      return found
    }
    const at = this.now()
    const entry: GroupEntry = {
      id: this.newId(),
      label: trimmed,
      key,
      source: opts.source ?? 'auto',
      createdAt: at,
      lastSeenAt: at,
    }
    this.byId.set(entry.id, entry)
    this.byKey.set(key, entry)
    this.dirty = true
    void this.persist()
    log.event('group-minted', { id: entry.id, label: entry.label, source: entry.source })
    return entry
  }

  /**
   * Author a group deliberately — the user typed it, or named it out loud.
   *
   * Adopting rather than duplicating is the point: if the router already minted
   * this stream as a guess, naming it does not create a second entry, it makes
   * the existing one THEIRS. That is also what protects it from `prune`.
   */
  define(label: string): { ok: boolean; reason?: 'blank'; entry?: GroupEntry } {
    const entry = this.resolve(label, { source: 'user' })
    return entry ? { ok: true, entry } : { ok: false, reason: 'blank' }
  }

  /**
   * Change a stream's display name. The id is untouched, so every task filed
   * under it stays filed — including tasks not currently loaded, which is
   * exactly what the old walk-and-rewrite rename could not manage.
   *
   * Uniqueness is enforced HERE, on the key, because this is the only place two
   * streams can be made to collide. Refusing names the entry it collided with,
   * so the caller can say which one rather than just "no".
   */
  rename(id: string, label: string): { ok: boolean; reason?: 'unknown' | 'duplicate' | 'blank'; entry?: GroupEntry } {
    const entry = this.byId.get(id)
    if (!entry) return { ok: false, reason: 'unknown' }
    const trimmed = (label ?? '').trim().slice(0, MAX_GROUP_LABEL)
    const key = groupKey(trimmed)
    if (!key) return { ok: false, reason: 'blank' }
    const clash = this.byKey.get(key)
    if (clash && clash.id !== id) return { ok: false, reason: 'duplicate', entry: clash }
    this.byKey.delete(entry.key)
    entry.label = trimmed
    entry.key = key
    entry.lastSeenAt = this.now()
    this.byKey.set(key, entry)
    this.dirty = true
    void this.persist()
    log.event('group-renamed', { id, label: trimmed })
    return { ok: true, entry }
  }

  /**
   * Drop machine-authored streams that hold nothing and have not been seen for
   * a long time. Returns what was removed.
   *
   * Two rules, and both matter. A `user` entry NEVER decays — they authored it,
   * and its absence would be a deletion they did not ask for. And an entry with
   * live members never decays regardless of age, because "idle" is about the
   * stream, not the clock.
   *
   * The window wants to be generous — weeks, not hours. An empty-but-remembered
   * entry is the whole mechanism by which a returning stream rejoins its old
   * name instead of minting a new one, so pruning eagerly re-creates the bug
   * this module exists to fix.
   */
  prune(opts: { liveIds: ReadonlySet<string>; idleMs: number }): GroupEntry[] {
    const cutoff = this.now() - opts.idleMs
    const removed: GroupEntry[] = []
    for (const entry of [...this.byId.values()]) {
      if (entry.source === 'user') continue
      if (opts.liveIds.has(entry.id)) continue
      if (entry.lastSeenAt > cutoff) continue
      this.byId.delete(entry.id)
      this.byKey.delete(entry.key)
      removed.push(entry)
    }
    if (removed.length) {
      this.dirty = true
      void this.persist()
      log.event('groups-pruned', { count: removed.length, labels: removed.map((e) => e.label) })
    }
    return removed
  }

  /** Mark a stream as still alive. Feeds the idle window in `prune`. */
  touch(id: string, at?: number): void {
    const entry = this.byId.get(id)
    if (!entry) return
    entry.lastSeenAt = at ?? this.now()
    this.dirty = true
    void this.persist()
  }

  /** Wait for pending writes — tests and shutdown. */
  async flush(): Promise<void> {
    await this.persist()
    if (this.writing) await this.writing
  }

  private async persist(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    const body: RegistryFile = { version: 1, entries: [...this.byId.values()] }
    this.writing = (async () => {
      try {
        await fs.mkdir(dirname(this.opts.path), { recursive: true })
        const tmp = `${this.opts.path}.tmp`
        await fs.writeFile(tmp, JSON.stringify(body, null, 2))
        await fs.rename(tmp, this.opts.path)
      } catch (e) {
        log.warn('registry write failed — groups will re-mint next launch', { error: (e as Error).message })
      }
    })()
    await this.writing
  }
}
