// Unmute Remote — skill/recipe store (PRD §8.2, §8.3).
//
// DECIDED: recipes ARE skills (one system). They live in a SHARED directory and
// are retrieved by Claude Code's native skill auto-discovery (description
// matching). Curated skills and librarian-authored recipes share the same
// folder + format; only their origin differs.
//
// Discovery mechanics: Claude Code auto-discovers skills from `.claude/skills/`
// in the session's working dir. Each task runs in its own per-task cwd
// (Unmute-owned), so for a task to SEE the accumulated recipes we install the
// shared skill set into that cwd's `.claude/skills/` at dispatch time. The
// librarian writes new/updated recipes back to the SHARED dir (single writer,
// §9), so the next task picks them up.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createLogger } from './log'

const log = createLogger('skills')

/** The shared skill/recipe library — the single source of truth (PRD §9.2). */
export function sharedSkillsDir(baseDir?: string): string {
  return join(baseDir ?? join(homedir(), '.unmute', 'remote'), 'skills')
}

/** Where Claude Code auto-discovers skills inside a session cwd. */
export function sessionSkillsDir(cwd: string): string {
  return join(cwd, '.claude', 'skills')
}

/**
 * Copy the shared skill set into a task's cwd so the doer auto-discovers them
 * (PRD §8.3). Best-effort: a missing shared dir just means "no recipes yet".
 */
export async function installSkillsIntoCwd(cwd: string, baseDir?: string): Promise<number> {
  const src = sharedSkillsDir(baseDir)
  const dst = sessionSkillsDir(cwd)
  let names: string[]
  try {
    names = await fs.readdir(src)
  } catch {
    log.debug('no shared skills dir yet — task runs with curated skills only', { src })
    return 0
  }
  await fs.mkdir(dst, { recursive: true })
  let copied = 0
  for (const name of names) {
    try {
      await fs.cp(join(src, name), join(dst, name), { recursive: true })
      copied++
    } catch (e) {
      log.warn('skill copy failed', { name, error: (e as Error).message })
    }
  }
  log.event('skills-installed-into-cwd', { cwd, copied })
  return copied
}

/** List recipe/skill files in the shared dir (for the librarian's context). */
export async function listSharedSkills(baseDir?: string): Promise<string[]> {
  try {
    return await fs.readdir(sharedSkillsDir(baseDir))
  } catch {
    return []
  }
}
