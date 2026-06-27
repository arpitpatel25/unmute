import { promises as fs } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { createLogger } from './log'

const log = createLogger('trace-reducer')

function defaultProjectsDir(): string { return join(homedir(), '.claude', 'projects') }

/** Resolve the executor's JSONL by taskId (the cwd's last segment), which is the
 *  suffix of Claude's encoded project-dir name. Robust to the exact encoding:
 *  we match the dir whose name CONTAINS the taskId, then take the newest jsonl. */
export async function locateTranscript(taskCwd: string, opts: { projectsDir?: string } = {}): Promise<string | null> {
  const taskId = basename(taskCwd)
  const projectsDir = opts.projectsDir ?? defaultProjectsDir()
  let dirs: string[]
  try { dirs = await fs.readdir(projectsDir) } catch { return null }
  const match = dirs.find((d) => d.includes(taskId))
  if (!match) {
    // TEMP(memory-debug): remove after calibration
    log.event('locate-transcript', { taskId, matched: false, resolved: null })
    return null
  }
  const dir = join(projectsDir, match)
  let files: string[]
  try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl')) } catch { return null }
  if (!files.length) {
    // TEMP(memory-debug): remove after calibration
    log.event('locate-transcript', { taskId, matched: true, resolved: null })
    return null
  }
  const withMtime = await Promise.all(files.map(async (f) => ({ f, m: (await fs.stat(join(dir, f))).mtimeMs })))
  withMtime.sort((a, b) => b.m - a.m)
  const resolved = join(dir, withMtime[0].f)
  // TEMP(memory-debug): remove after calibration
  log.event('locate-transcript', { taskId, matched: true, resolved })
  return resolved
}
