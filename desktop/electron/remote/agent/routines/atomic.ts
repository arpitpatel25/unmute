import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'

/**
 * Writes `content` to `path` without ever leaving a truncated file behind:
 * write to a fresh sibling temp file, then rename it into place, which is
 * atomic at the filesystem level. Mode 0o600 because routine definitions and
 * run logs may hold prompt text and result previews the user wrote.
 *
 * Not `electron/remote/atomic-file.ts`'s `writeFileAtomic` — that helper
 * doesn't set a mode and uses a different temp-name scheme; this one matches
 * what the routines store/run-log were specified to do.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, content, { mode: 0o600 })
  await fs.rename(tmp, path)
}
