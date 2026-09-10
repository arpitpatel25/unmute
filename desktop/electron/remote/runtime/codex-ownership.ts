import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CodexOwnershipStore } from './codex-routing'
import { readCodexIdentity } from './codex-identity'

/** Which tasks belong to one worker generation, kept where a restart can find it.
 *
 *  One task id per line, append-only. Append is the point: a rewrite can be torn
 *  by a crash and lose ownership for every task at once, which is the exact
 *  failure this file exists to prevent. Only a missing file means no ownership;
 *  an unreadable file must never silently redirect work to another writer.
 *
 *  Entries are never removed, so the file grows by one line per task ever forked.
 *  At one line per task that stays trivially small; add compaction only if task
 *  deletion ever needs ownership dropped with it. */
export function fileOwnershipStore(dir: string, generation: string): CodexOwnershipStore {
  const file = join(dir, `codex-ownership-${generation}.txt`)
  const read = (): string[] => {
    try {
      return readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(Boolean)
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  return {
    initial: () => [...new Set(read())],
    recoverIdentity: (taskId, source) => readCodexIdentity(join(dir, generation, 'codex'), taskId, source, read().includes(taskId)),
    remember(taskId: string): void {
      if (!taskId || read().includes(taskId)) return
      mkdirSync(dir, { recursive: true })
      appendFileSync(file, `${taskId}\n`)
    },
  }
}
