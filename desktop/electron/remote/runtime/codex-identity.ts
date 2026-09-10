import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface CodexIdentity { taskId: string; threadId: string; forkedFromId?: string }

export function codexIdentityFile(root: string, taskId: string): string {
  return join(root, `identity-${createHash('sha256').update(taskId).digest('hex')}.json`)
}

/** Read task-specific receipts even when a surviving daemon has no identity API.
 * Anonymous operation receipts require an explicit, evidence-backed migration;
 * neither a shared cwd nor generation ownership proves which card forked. */
export async function readCodexIdentity(root: string, taskId: string, expected?: string, legacyOwned = false): Promise<CodexIdentity | null> {
  let canonical: CodexIdentity | undefined
  try { canonical = JSON.parse(await readFile(codexIdentityFile(root, taskId), 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (canonical && (canonical.taskId !== taskId || !canonical.threadId)) throw new Error('Invalid canonical Codex identity')
  if (canonical && expected && expected !== canonical.threadId && expected !== canonical.forkedFromId) {
    throw new Error('Canonical Codex identity contradicts the task receipt')
  }
  // New runtimes commit this task-specific record BEFORE an operation receipt.
  // Anonymous forks can belong to another card and cannot supersede it.
  if (canonical || !legacyOwned || !expected) return canonical ?? null
  // Pre-operation-ID forks still have an exact task/source key. Do not walk
  // beyond this edge: a subsequent fork may belong to a different task.
  const key = createHash('sha256').update(JSON.stringify([taskId, expected, 'fork'])).digest('hex')
  let value: { threadId?: unknown; forkedFromId?: unknown }
  try { value = JSON.parse(await readFile(join(root, `${key}.json`), 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  if (!value || typeof value.threadId !== 'string' || !value.threadId || value.threadId === expected || value.forkedFromId !== expected) {
    throw new Error('Invalid durable Codex fork identity')
  }
  return { taskId, threadId: value.threadId, forkedFromId: expected }
}
