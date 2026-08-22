import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'

/**
 * Write `content` to `path` without ever leaving a truncated/empty file
 * behind if the process dies mid-write.
 *
 * `fs.writeFile` truncates the destination to empty, THEN writes the new
 * bytes — two separate steps. A process that dies between them (an app quit,
 * a crash, a force-relaunch) leaves the file empty forever, since nothing
 * else ever rewrites it — this is exactly what turned several real tasks'
 * `meta.json` into 0-byte files, silently dropping them from the dashboard.
 *
 * Writing the new content to a fresh sibling file first and renaming it into
 * place instead makes the swap atomic at the filesystem level: `path` is
 * always either the complete OLD content or the complete NEW content, never
 * a partial one, regardless of when the process dies. Same pattern git,
 * editors, and package managers use for durable config/state writes.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${randomUUID()}`
  await fs.writeFile(tmp, content)
  await fs.rename(tmp, path)
}
