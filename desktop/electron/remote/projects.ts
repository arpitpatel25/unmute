// Unmute Remote — known Claude Code projects (Orchestrate: project-bound spawn).
//
// "Work on the unmute repo" must resolve to a real directory. The single best
// source is Claude Code's own memory: ~/.claude.json carries a `projects` map
// keyed by every ABSOLUTE PATH the user has ever run claude in. That list is the
// user's real project universe — no guessing, no directory scanning.
//
// It's also huge and noisy (hundreds of entries, including throwaway worktrees),
// so it's curated before it reaches the router prompt:
//   * drop paths that no longer exist
//   * drop machine-made noise (~/.claude-worktrees/*, our own ~/.unmute scratch)
//   * rank by recency — the mtime of the project's transcript dir under
//     ~/.claude/projects/<slug> (it advances on every session) — and cap.
//
// READ-ONLY: this module never writes anywhere near ~/.claude.
//
// The pure parts (parse/curate/slug) are dependency-injected for unit tests;
// knownProjects() is the thin IO wrapper init.ts calls.

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { createLogger } from './log'

const log = createLogger('projects')

export interface KnownProject {
  /** Absolute path of the project directory. */
  path: string
  /** Short human name (the directory's basename) — what people SAY. */
  name: string
  /** Recency signal (ms epoch) — transcript-dir mtime; 0 when unknown. */
  lastUsedMs: number
}

/** Claude Code's transcript-dir slug for a project path: every run of
 *  non-alphanumeric characters becomes '-' (verified against a real install:
 *  /a/b.c_d → -a-b-c-d). Used ONLY as a recency lookup key — a miss just
 *  ranks the project older, never drops it. */
export function projectSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]+/g, '-')
}

/** Pure: extract the project paths from a raw ~/.claude.json body. Returns []
 *  on any malformed input — this feeds a prompt, never control flow. */
export function parseProjectPaths(claudeJsonRaw: string): string[] {
  try {
    const parsed = JSON.parse(claudeJsonRaw) as { projects?: Record<string, unknown> }
    return Object.keys(parsed.projects ?? {}).filter((p) => p.startsWith('/'))
  } catch {
    return []
  }
}

/** Pure: filter noise + rank by recency + cap. IO comes in as functions so this
 *  is unit-testable without a filesystem. */
export async function curateProjects(
  paths: string[],
  io: { exists: (p: string) => Promise<boolean>; mtimeMs: (p: string) => Promise<number> },
  limit = 20,
): Promise<KnownProject[]> {
  const NOISE = ['/.claude-worktrees/', '/.unmute/', '/node_modules/']
  const candidates = paths.filter((p) => p !== '/' && !NOISE.some((n) => p.includes(n)))
  const alive: KnownProject[] = []
  for (const path of candidates) {
    if (!(await io.exists(path))) continue
    alive.push({ path, name: basename(path), lastUsedMs: await io.mtimeMs(path) })
  }
  return alive.sort((a, b) => b.lastUsedMs - a.lastUsedMs).slice(0, limit)
}

/** The user's known projects, curated and recency-ranked (thin IO wrapper). */
export async function knownProjects(limit = 20): Promise<KnownProject[]> {
  const home = homedir()
  let raw: string
  try {
    raw = await fs.readFile(join(home, '.claude.json'), 'utf8')
  } catch {
    return [] // no claude config — no known projects, routing falls back cleanly
  }
  const transcriptRoot = join(home, '.claude', 'projects')
  const projects = await curateProjects(parseProjectPaths(raw), {
    exists: async (p) => { try { return (await fs.stat(p)).isDirectory() } catch { return false } },
    mtimeMs: async (p) => { try { return (await fs.stat(join(transcriptRoot, projectSlug(p)))).mtimeMs } catch { return 0 } },
  }, limit)
  log.event('known-projects', { total: projects.length })
  return projects
}
