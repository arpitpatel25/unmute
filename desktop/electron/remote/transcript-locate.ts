// FIND A TRANSCRIPT BY ITS SESSION ID, NOT BY GUESSING ITS FOLDER.
//
// THE ASSUMPTION THIS REPLACES. `~/.claude/projects/<slug(cwd)>/<id>.jsonl`
// was treated as a permanent address, fixed when the task was dispatched. Only
// half of it is: the FILENAME is the session id and never changes, but the
// FOLDER is derived from the session's CURRENT working directory. Claude files
// a transcript under the project folder for where the session is now, so a
// session that changes directory takes its transcript with it — that is
// deliberate on Claude's side, and it is what makes `claude --resume` inside a
// directory list that directory's sessions.
//
// FIELD RECORD (2026-08-30). Task 87083840 ran with `--session-id 1f9cd2d0…`
// in `…/unmute-cloud`, resolved fine, and showed 77 blocks of its own work.
// Mid-session it entered a git worktree; Claude moved the file to
// `…unmute-cloud--claude-worktrees-session-record-rebuild/`. Nothing noticed
// until the app relaunched and re-resolved — the derived path was gone, the
// caller fell back to "newest .jsonl in the folder", and bound the card to a
// DIFFERENT live session: 5.4 MB of another conversation, followed live
// because the watcher went with it. Two cards, one transcript.
//
// The id is exact and unique. Searching for it cannot pick the wrong session,
// which is the property the folder-derived path never had.

import fs from 'node:fs/promises'
import { join } from 'node:path'
import { transcriptPathFor, defaultProjectsDir } from './trace-reducer'

/** Depth of the walk under ~/.claude/projects. The layout is one flat level of
 *  slug directories, so 1 is enough; 2 is slack for a future nesting. */
const MAX_DEPTH = 2

async function existing(path: string): Promise<string | null> {
  try { await fs.stat(path); return path } catch { return null }
}

async function findUnder(dir: string, filename: string, depth = 0): Promise<string | null> {
  if (depth > MAX_DEPTH) return null
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
  try {
    entries = await fs.readdir(dir, { withFileTypes: true }) as unknown as typeof entries
  } catch { return null }
  const dirs: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) dirs.push(join(dir, entry.name))
    // EXACT, never a prefix. A truncated id resolving to the session it
    // prefixes would show the wrong conversation, which is the bug this file
    // exists to close rather than reproduce in a new place.
    else if (entry.isFile() && entry.name === filename) return join(dir, entry.name)
  }
  for (const child of dirs) {
    const hit = await findUnder(child, filename, depth + 1)
    if (hit) return hit
  }
  return null
}

/**
 * The transcript for exactly this session, wherever it now lives.
 *
 * The folder derived from `cwd` is checked FIRST, so the ordinary case — a
 * session that never moved — costs one stat rather than a directory walk. The
 * search only runs when that misses, which is precisely when the session has
 * moved and the derived path is stale.
 *
 * Returns null rather than a neighbour. A card with no transcript is correct;
 * a card showing someone else's is not.
 */
export async function findTranscriptById(
  cwd: string,
  sessionId: string,
  opts: { projectsDir?: string } = {},
): Promise<string | null> {
  const id = sessionId.trim()
  if (!id) return null
  const direct = await existing(transcriptPathFor(cwd, id, opts))
  if (direct) return direct
  const projectsDir = opts.projectsDir ?? defaultProjectsDir()
  return findUnder(projectsDir, `${id}.jsonl`)
}
