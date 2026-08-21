import { promises as fs } from 'node:fs'

export interface AppendFileRead {
  text: string
  changed: boolean
  recovered: boolean
  missing: boolean
  /** Physical bytes fetched from disk for this call (not cached bytes). */
  bytesRead: number
  size: number
  fileId?: string
}

interface CachedFile {
  fileId: string
  mtimeMs: number
  bytes: Buffer
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/**
 * Append-aware text reader for provider JSONL/transcript files.
 *
 * The cached Buffer intentionally preserves incomplete UTF-8 and JSONL tails;
 * converting the concatenated buffer after an append cannot split a code point
 * that happened to straddle two physical reads.
 */
export class AppendFileCache {
  private readonly files = new Map<string, CachedFile>()

  constructor(private readonly maxEntries = 64) {}

  async read(path: string): Promise<AppendFileRead> {
    return this.readStable(path, true)
  }

  forget(path: string): void {
    this.files.delete(path)
  }

  clear(): void {
    this.files.clear()
  }

  private async readStable(path: string, mayRetry: boolean): Promise<AppendFileRead> {
    let before: import('node:fs').Stats
    try {
      before = await fs.stat(path)
    } catch (error) {
      if (!missing(error)) throw error
      const changed = this.files.delete(path)
      return { text: '', changed, recovered: false, missing: true, bytesRead: 0, size: 0 }
    }

    const fileId = `${before.dev}:${before.ino}`
    const cached = this.files.get(path)
    const sameFile = cached?.fileId === fileId
    const append = sameFile && before.size > cached.bytes.length
    const unchanged = sameFile
      && before.size === cached.bytes.length
      && before.mtimeMs === cached.mtimeMs

    if (unchanged) {
      this.touch(path, cached)
      return {
        text: cached.bytes.toString('utf8'), changed: false, recovered: false,
        missing: false, bytesRead: 0, size: cached.bytes.length, fileId,
      }
    }

    // Same inode + growth is the normal provider write path. Same-size writes,
    // truncation, and replacement are recovery boundaries and must reread from
    // byte zero rather than trusting the old prefix.
    const offset = append ? cached.bytes.length : 0
    const length = Math.max(0, before.size - offset)
    const chunk = Buffer.allocUnsafe(length)
    let bytesRead = 0
    const handle = await fs.open(path, 'r')
    try {
      while (bytesRead < length) {
        const read = await handle.read(chunk, bytesRead, length - bytesRead, offset + bytesRead)
        if (read.bytesRead === 0) break
        bytesRead += read.bytesRead
      }
    } finally {
      await handle.close()
    }

    let after: import('node:fs').Stats
    try {
      after = await fs.stat(path)
    } catch (error) {
      if (missing(error) && mayRetry) {
        this.files.delete(path)
        return this.readStable(path, false)
      }
      throw error
    }
    const afterId = `${after.dev}:${after.ino}`
    if (afterId !== fileId && mayRetry) {
      this.files.delete(path)
      return this.readStable(path, false)
    }

    const actual = chunk.subarray(0, bytesRead)
    const bytes = append ? Buffer.concat([cached.bytes, actual]) : Buffer.from(actual)
    this.touch(path, { fileId: afterId, mtimeMs: after.mtimeMs, bytes })
    return {
      text: bytes.toString('utf8'),
      changed: !cached || !bytes.equals(cached.bytes),
      recovered: !append,
      missing: false,
      bytesRead,
      size: bytes.length,
      fileId: afterId,
    }
  }

  private touch(path: string, file: CachedFile): void {
    this.files.delete(path)
    this.files.set(path, file)
    const limit = Math.max(1, this.maxEntries)
    while (this.files.size > limit) {
      this.files.delete(this.files.keys().next().value as string)
    }
  }
}
