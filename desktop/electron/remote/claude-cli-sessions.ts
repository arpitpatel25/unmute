/**
 * CLAUDE CODE CLI SESSIONS THAT ARE NOT OURS — the import list, and nothing more.
 *
 * People already have Claude Code threads running in iTerm, Terminal, wherever.
 * Those are real work with real history, and until now the only way to get one
 * onto the wall was to start a new session and lose the context. This scans for
 * them so they can be adopted by a tap.
 *
 * WHAT IS ON DISK, and it is more than you would expect:
 *
 *   ~/.claude/projects/<cwd-with-slashes-as-dashes>/<sessionId>.jsonl
 *
 * The directory names the working directory, the FILE names the session, the
 * mtime is the last interaction, and — the useful surprise — line 1 of every
 * transcript is `{"type":"summary"|…,"aiTitle":"…","sessionId":"…"}`. Claude
 * Code has already written a human title for each one, so the list needs no
 * model and no guessing at first messages.
 *
 * READ-ONLY, ALWAYS. This never writes to ~/.claude. That directory belongs to
 * Claude Code, which cleans its own transcripts on its own schedule, and the
 * file sovereignty rule in the project overview is explicit about it.
 *
 * DELIBERATELY NOT A WATCHER. It is a scan, run when the dashboard opens. A few
 * hundred stats cost nothing next to keeping an index in step with a directory
 * another program owns.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createLogger } from './log'

const log = createLogger('claude-cli-sessions')

/** One importable session. Everything the card needs and nothing else. */
export interface ImportableSession {
  sessionId: string
  /** Claude Code's own title for the thread. Falls back to the folder name. */
  title: string
  cwd: string
  /** Last time the transcript was written — the honest "last interaction". */
  lastActivityAt: number
  /** Project the session ran in. The grouping axis; see init.ts. */
  project: string
}

/** Older than this and it is history, not something you are coming back to. */
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Written to this recently and something is almost certainly still typing in it.
 *
 * A LIVE session is the least importable thing on the list, and it sorts to the
 * TOP because it has the newest mtime — so it is the row you reach for first.
 * `--resume` against a running process is not a resume; at best Claude Code
 * refuses, at worst two processes share one transcript.
 *
 * Found the hard way: the first session offered by this rail was the one the
 * user was talking to us in.
 *
 * A HEURISTIC, and named as one. Freshness is evidence of life, not proof — a
 * session someone abandoned ninety seconds ago is excluded too. That is the
 * right way to be wrong: the cost is waiting two minutes to import something,
 * against handing someone a button that corrupts a running conversation.
 */
const LIVE_MS = 2 * 60 * 1000

/**
 * Paths that are not projects.
 *
 * A machine with 745 transcripts has maybe twenty that are real work; the rest
 * are probes, scratchpads and one-shot temp dirs. An unfiltered list is not a
 * list, it is a haystack, and every row in it is a chance to import the wrong
 * thing.
 */
const NOT_A_PROJECT = /^(-private-tmp|-tmp|-var-folders|-private-var)/

/** `~/.claude/projects` encodes the cwd by replacing every slash with a dash,
 *  which is lossy — a directory with a dash in its name is indistinguishable
 *  from a path separator. We reconstruct the obvious way and let the session's
 *  own record correct us where it can. */
function decodeCwd(dirName: string): string {
  return dirName.replace(/^-/, '/').replace(/-/g, '/')
}

function projectOf(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] || cwd
}

/**
 * Title and TRUE working directory, from the head of the transcript.
 *
 * The title is on line 1. The cwd is NOT — line 1 is a summary record — but it
 * appears within the first handful of message entries, and it is the only
 * trustworthy source for it.
 *
 * WHY NOT DERIVE THE CWD FROM THE DIRECTORY NAME: because that encoding is
 * lossy and the loss is not cosmetic. `~/.claude/projects` replaces every slash
 * with a dash, so `/Users/me/tools/unmute/unmute-cloud` and
 * `/Users/me/tools/unmute/unmute/cloud` are the same directory name, and
 * reconstructing picks the wrong one for any project with a dash in it — which
 * is most of them. The first version of this file guessed, and the guess did
 * not merely mislabel the group: `resume()` checks `fs.access(task.cwd)` and
 * bails silently when it fails, so every imported session from a dashed path
 * produced a card whose Resume button did nothing at all.
 *
 * A bounded read, not the whole file: these run to megabytes and we need the
 * first few records.
 */
async function readHeader(path: string): Promise<{ aiTitle?: string; cwd?: string } | null> {
  let fh
  try {
    fh = await fs.open(path, 'r')
    const buf = Buffer.alloc(65536)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    // Drop the trailing fragment: the last line is almost certainly cut mid-way.
    const lines = text.split('\n').slice(0, -1)
    const out: { aiTitle?: string; cwd?: string } = {}
    for (const line of lines) {
      if (!line) continue
      let rec: { aiTitle?: string; cwd?: string }
      try { rec = JSON.parse(line) } catch { continue }
      if (!out.aiTitle && typeof rec.aiTitle === 'string') out.aiTitle = rec.aiTitle
      if (!out.cwd && typeof rec.cwd === 'string') out.cwd = rec.cwd
      if (out.aiTitle && out.cwd) break
    }
    return out
  } catch {
    return null // truncated, mid-write, or not JSON — it simply does not list
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * Every CLI session worth offering, newest first.
 *
 * @param known session ids unmute already has. They are not offered — an import
 *              list whose rows do nothing is worse than a shorter list.
 */
export async function listImportableSessions(
  known: ReadonlySet<string>,
  opts: { root?: string; now?: number; windowMs?: number; cap?: number; liveMs?: number } = {},
): Promise<ImportableSession[]> {
  const root = opts.root ?? join(homedir(), '.claude', 'projects')
  const now = opts.now ?? Date.now()
  const windowMs = opts.windowMs ?? WINDOW_MS
  const cap = opts.cap ?? 40

  let dirs: string[]
  try {
    dirs = await fs.readdir(root)
  } catch {
    return [] // no Claude Code on this machine, which is not an error
  }

  const out: ImportableSession[] = []
  let scanned = 0, skippedTemp = 0, skippedOld = 0, skippedKnown = 0, skippedNoCwd = 0, skippedLive = 0

  for (const dirName of dirs) {
    if (NOT_A_PROJECT.test(dirName)) { skippedTemp++; continue }
    const dir = join(root, dirName)
    let files: string[]
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'))
    } catch { continue }

    for (const file of files) {
      scanned++
      const sessionId = file.replace(/\.jsonl$/, '')
      if (known.has(sessionId)) { skippedKnown++; continue }
      let stat
      try { stat = await fs.stat(join(dir, file)) } catch { continue }
      const lastActivityAt = stat.mtimeMs
      if (now - lastActivityAt > windowMs) { skippedOld++; continue }
      if (now - lastActivityAt < (opts.liveMs ?? LIVE_MS)) { skippedLive++; continue }
      // An empty or near-empty transcript is a session that was opened and
      // abandoned. Importing one gives you a card with nothing behind it.
      if (stat.size < 2048) continue

      const head = await readHeader(join(dir, file))
      // The transcript's own record wins; the directory name is a last resort
      // and is known to be wrong for dashed paths (see readHeader).
      const cwd = head?.cwd ?? decodeCwd(dirName)
      // A SESSION WHOSE PROJECT IS GONE CANNOT BE RESUMED. `resume()` requires
      // the directory to exist and returns false without it, so offering one is
      // offering a button that does nothing — the exact failure this fix is for.
      try { await fs.access(cwd) } catch { skippedNoCwd++; continue }
      out.push({
        sessionId,
        title: head?.aiTitle?.trim() || projectOf(cwd),
        cwd,
        lastActivityAt,
        project: projectOf(cwd),
      })
    }
  }

  out.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  log.event('cli-sessions-scanned', {
    scanned, offered: Math.min(out.length, cap), skippedTemp, skippedOld, skippedKnown, skippedNoCwd, skippedLive,
  })
  return out.slice(0, cap)
}

/**
 * The TRUE working directory of a session, found by id alone.
 *
 * The recovery half of the cwd bug. A task can hold a path that is wrong (an
 * import made before the scanner read the transcript) or merely stale (the repo
 * moved, the folder was renamed), and `resume()` refuses to spawn into a
 * directory it cannot reach — silently, for every caller.
 *
 * Rather than repair records at one entry point and hope the others never see
 * them, `resume()` calls this and heals the task in place. Every surface that
 * can resume — the card, voice, the router, revive-on-send — inherits it,
 * because they all pass through that one function.
 *
 * Searches by FILENAME, which is the session id, so it does not need to know
 * where the session used to live.
 */
export async function findSessionCwd(sessionId: string, root?: string): Promise<string | null> {
  const base = root ?? join(homedir(), '.claude', 'projects')
  let dirs: string[]
  try { dirs = await fs.readdir(base) } catch { return null }
  for (const dirName of dirs) {
    const file = join(base, dirName, sessionId + '.jsonl')
    try { await fs.access(file) } catch { continue }
    const head = await readHeader(file)
    if (head?.cwd) {
      // Only useful if it is somewhere we can actually spawn.
      try { await fs.access(head.cwd); return head.cwd } catch { return null }
    }
    return null
  }
  return null
}
