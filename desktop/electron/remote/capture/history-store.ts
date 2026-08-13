import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'

export type CaptureHistoryKind = 'dictation' | 'scratchpad'
export type CaptureHistoryDestination = 'cursor' | 'task'

export interface CaptureHistoryEntry {
  id: string
  kind: CaptureHistoryKind
  createdAt: number
  finalizedAt: number
  text: string
  destination: CaptureHistoryDestination
  taskId?: string
  /** Files owned by this history record. These, and only these, may be purged. */
  attachments: string[]
  saved?: boolean
}

export function clipboardPayload(entry: CaptureHistoryEntry): { text: string; attachments: string[] } {
  return { text: entry.text, attachments: [...entry.attachments] }
}

const RETENTION_MS = 24 * 60 * 60 * 1000
const INDEX = 'history.json'

/**
 * Small file-backed archive for the capture layer. It deliberately does not
 * share the SQLite session table: Remote lives under electron/paywall after
 * wiring, while the engine owns that table. Keeping this archive self-contained
 * makes its retention and attachment ownership explicit.
 */
export class CaptureHistoryStore {
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly root: string) {}

  record(entry: CaptureHistoryEntry): void {
    const entries = this.read()
    const next = { ...entry, attachments: [...entry.attachments], saved: entry.saved === true }
    const at = entries.findIndex((candidate) => candidate.id === entry.id)
    if (at >= 0) entries[at] = next
    else entries.push(next)
    this.write(entries)
    this.scheduleCleanup()
  }

  /** Copy attachments into the archive before recording them. Original files
   * remain untouched: screenshot paths may point at a user's own files. */
  archive(entry: Omit<CaptureHistoryEntry, 'attachments'> & { attachments: readonly string[] }): CaptureHistoryEntry {
    const attachmentDir = join(this.root, entry.id)
    // `record` is an upsert (late finalization can replace a draft); do not
    // leave unreferenced images from the earlier revision behind.
    try { rmSync(attachmentDir, { recursive: true, force: true }) } catch { /* best effort */ }
    mkdirSync(attachmentDir, { recursive: true })
    const attachments: string[] = []
    for (const [index, source] of entry.attachments.entries()) {
      try {
        if (!existsSync(source)) continue
        const suffix = extname(source) || '.bin'
        const target = join(attachmentDir, `${index}-${basename(source, suffix).replace(/[^a-zA-Z0-9._-]/g, '_')}${suffix}`)
        copyFileSync(source, target)
        attachments.push(target)
      } catch (error) {
        console.warn('[capture-history] attachment archive failed:', error)
      }
    }
    const saved: CaptureHistoryEntry = { ...entry, attachments, saved: entry.saved === true }
    this.record(saved)
    return saved
  }

  list(kind?: CaptureHistoryKind, now = Date.now()): CaptureHistoryEntry[] {
    this.cleanup(now)
    return this.read()
      .filter((entry) => !kind || entry.kind === kind)
      .sort((a, b) => b.finalizedAt - a.finalizedAt)
  }

  setSaved(id: string, saved: boolean): boolean {
    const entries = this.read()
    const entry = entries.find((candidate) => candidate.id === id)
    if (!entry) return false
    entry.saved = saved
    this.write(entries)
    this.scheduleCleanup()
    return true
  }

  delete(id: string): boolean {
    const entries = this.read()
    const target = entries.find((entry) => entry.id === id)
    if (!target) return false
    this.removeOwned(target)
    this.write(entries.filter((entry) => entry.id !== id))
    this.scheduleCleanup()
    return true
  }

  cleanup(now = Date.now()): void {
    const cutoff = now - RETENTION_MS
    const entries = this.read()
    const expired = entries.filter((entry) => !entry.saved && entry.finalizedAt < cutoff)
    if (expired.length) {
      for (const entry of expired) this.removeOwned(entry)
      this.write(entries.filter((entry) => entry.saved || entry.finalizedAt >= cutoff))
    }
    this.scheduleCleanup()
  }

  private read(): CaptureHistoryEntry[] {
    try {
      const value: unknown = JSON.parse(readFileSync(join(this.root, INDEX), 'utf8'))
      if (!Array.isArray(value)) return []
      return value.filter(validEntry)
    } catch { return [] }
  }

  private write(entries: CaptureHistoryEntry[]): void {
    mkdirSync(this.root, { recursive: true })
    const target = join(this.root, INDEX)
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(entries), 'utf8')
    renameSync(temp, target)
  }

  private removeOwned(entry: CaptureHistoryEntry): void {
    for (const attachment of entry.attachments) {
      // Never follow a history-file path outside the archive root.
      if (!isInside(this.root, attachment)) continue
      try { rmSync(attachment, { force: true }) } catch { /* best effort */ }
    }
    const entryDir = join(this.root, entry.id)
    if (isInside(this.root, entryDir)) {
      try { rmSync(entryDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  /** Schedule exactly at the next unsaved record's expiry. Timers are unref'd,
   * so this privacy housekeeping never keeps the app alive. */
  private scheduleCleanup(): void {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer)
    const next = this.read()
      .filter((entry) => !entry.saved)
      .reduce<number | null>((earliest, entry) => {
        const expiresAt = entry.finalizedAt + RETENTION_MS
        return earliest === null || expiresAt < earliest ? expiresAt : earliest
      }, null)
    if (next === null) { this.cleanupTimer = null; return }
    this.cleanupTimer = setTimeout(() => this.cleanup(Date.now()), Math.max(0, next - Date.now()))
    this.cleanupTimer.unref?.()
  }
}

function isInside(root: string, value: string): boolean {
  const relative = resolve(value).slice(resolve(root).length)
  return relative.startsWith('/') || relative.startsWith('\\')
}

function validEntry(value: unknown): value is CaptureHistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<CaptureHistoryEntry>
  return typeof entry.id === 'string'
    && (entry.kind === 'dictation' || entry.kind === 'scratchpad')
    && typeof entry.createdAt === 'number'
    && typeof entry.finalizedAt === 'number'
    && typeof entry.text === 'string'
    && (entry.destination === 'cursor' || entry.destination === 'task')
    && Array.isArray(entry.attachments)
    && entry.attachments.every((attachment) => typeof attachment === 'string')
}
