import { promises as fs, constants } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'

export type NewChatOptions = { provider: 'claude' | 'codex'; cwd?: string; allocationId?: string; permission?: string }
export type ChatPreview = { allocationId: string; path: string; permission: string; permissionReason?: string }

/** Resolve existing ancestors without creating the proposed project. */
async function resolvedPath(path: string): Promise<string> {
  try { return await fs.realpath(path) }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    const parent = dirname(path)
    if (parent === path) throw e
    return join(await resolvedPath(parent), basename(path))
  }
}

export async function validateProject(path: string): Promise<void> {
  try {
    if (!(await fs.stat(path)).isDirectory()) throw new Error('Not a directory')
    await fs.access(path, constants.R_OK | constants.W_OK | constants.X_OK)
  } catch (error) { throw new Error(`The project folder is unavailable or inaccessible: ${path} (${(error as Error).message})`) }
}

/** Reservations are process-local and never create directories until consumed. */
export class ManagedProjects {
  private reservations = new Map<string, { path: string; provider: string; expires: number }>()
  constructor(private root: string) {}
  async preview(provider: string): Promise<{ allocationId: string; path: string }> {
    const now = Date.now()
    for (const [id, r] of this.reservations) if (r.expires < now) this.reservations.delete(id)
    const allocationId = randomUUID()
    const path = join(await resolvedPath(resolve(this.root)), allocationId)
    this.reservations.set(allocationId, { path, provider, expires: now + 60 * 60 * 1000 })
    return { allocationId, path }
  }
  async create(provider: string, allocationId?: string): Promise<{ managedProjectId: string; cwd: string }> {
    const id = allocationId ?? (await this.preview(provider)).allocationId
    const r = this.reservations.get(id)
    if (!r || r.provider !== provider || r.expires < Date.now()) throw new Error('Project preview expired or changed. Preview the project again.')
    if (join(await resolvedPath(resolve(this.root)), id) !== r.path) throw new Error('Project storage changed. Preview the project again.')
    await fs.mkdir(dirname(r.path), { recursive: true, mode: 0o700 })
    await validateProject(dirname(r.path))
    // Exclusive leaf creation: a colliding path is never reused or replaced.
    try { await fs.mkdir(r.path, { mode: 0o700 }) }
    catch (error) { throw new Error(`Could not create the previewed project ${r.path}: ${(error as Error).message}`) }
    this.reservations.delete(id)
    return { managedProjectId: id, cwd: r.path }
  }
}
