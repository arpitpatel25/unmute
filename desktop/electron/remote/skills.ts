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
import { graduatedDir } from './recipe-store'
import { GENERAL_SURFACE } from './surface'

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
 * Copy graduated skills for the given surface + general into a task's cwd so
 * the doer auto-discovers them (PRD §8.3). Best-effort: a missing dir means
 * "no recipes yet" for that surface.
 */
export async function installSkillsIntoCwd(cwd: string, opts: { surface?: string; baseDir?: string } = {}): Promise<number> {
  const dst = sessionSkillsDir(cwd)
  const surfaces = Array.from(new Set([opts.surface, GENERAL_SURFACE].filter(Boolean) as string[]))
  let copied = 0
  for (const surface of surfaces) {
    const src = join(graduatedDir(opts.baseDir), surface)
    let names: string[]
    try { names = await fs.readdir(src) } catch { continue }
    await fs.mkdir(dst, { recursive: true })
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      try {
        await fs.cp(join(src, name), join(dst, name), { recursive: true })
        copied++
      } catch (e) {
        log.warn('skill copy failed', { name, error: (e as Error).message })
      }
    }
  }
  // TEMP(memory-debug): remove after calibration
  log.event('skills-installed-into-cwd', { MEMORY_DEBUG: true, cwd, surfaces, copied })
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

// ─── User profile (the SECOND store) ──────────────────────────────────────
//
// Distinct from skills: the profile holds durable FACTS & PREFERENCES about the
// user (which accounts, preferred apps, main email, key contacts, conventions)
// — the stuff that lets a terse command succeed without the user re-specifying
// it. Plain markdown the doer Reads on demand; the librarian is the only writer.

/** The shared user-profile file — durable facts/preferences (single source). */
export function userProfilePath(baseDir?: string): string {
  return join(baseDir ?? join(homedir(), '.unmute', 'remote'), 'profile.md')
}

/** Read the user profile (empty string if none yet). For librarian context. */
export async function readUserProfile(baseDir?: string): Promise<string> {
  try {
    return await fs.readFile(userProfilePath(baseDir), 'utf8')
  } catch {
    return ''
  }
}

/** Copy the profile into a task's cwd as PROFILE.md so the doer can Read it on
 *  demand (the contract points at ./PROFILE.md). Best-effort; absent = no-op. */
export async function installProfileIntoCwd(cwd: string, baseDir?: string): Promise<boolean> {
  const content = await readUserProfile(baseDir)
  if (!content.trim()) return false
  try {
    await fs.writeFile(join(cwd, 'PROFILE.md'), content, 'utf8')
    log.event('profile-installed-into-cwd', { cwd, bytes: content.length })
    return true
  } catch (e) {
    log.warn('profile install failed', { error: (e as Error).message })
    return false
  }
}

/** The skills "index": each skill's `name` + first-line `description` from its
 *  frontmatter, so the librarian sees what already exists WITHOUT loading every
 *  body. Keeps the librarian's context bounded as the library grows. */
export async function skillsIndex(baseDir?: string): Promise<Array<{ name: string; description: string }>> {
  const dir = sharedSkillsDir(baseDir)
  let names: string[]
  try { names = await fs.readdir(dir) } catch { return [] }
  const out: Array<{ name: string; description: string }> = []
  for (const name of names) {
    let description = ''
    try {
      // Skill may be a dir (SKILL.md) or a flat .md file.
      const stat = await fs.stat(join(dir, name))
      const file = stat.isDirectory() ? join(dir, name, 'SKILL.md') : join(dir, name)
      const text = await fs.readFile(file, 'utf8')
      const m = text.match(/^description:\s*(.+)$/m)
      description = m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
    } catch { /* unreadable skill — list name only */ }
    out.push({ name, description })
  }
  return out
}
