// Unmute Remote — Claude desktop READ side: the on-disk session store.
//
// Claude Desktop keeps two separate things in two separate trees, and the whole
// point of this module is that BOTH are plain files:
//
//   ~/Library/Application Support/Claude/claude-code-sessions/<a>/<b>/local_<uuid>.json
//       one file per task: title, model, cwd, permission mode, activity times.
//
//   ~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl
//       the conversation itself — the SAME format the Claude Code CLI writes,
//       because the desktop app embeds the CLI (claude-code/<version>).
//
// Reading from disk instead of the accessibility tree is not an optimisation,
// it is a correctness requirement. The AX message list is VIRTUALISED: measured
// on a live machine, ~10 turns were exposed for a conversation of 277. Anything
// that renders history from AX shows a truncated conversation and cannot know
// it. Disk is also free, works while Claude Desktop is CLOSED, needs no launch
// flag, and never touches the user's focus.
//
// KEYING. `sessionId` is the primary key — measured unique 33/33 on a real
// store. `cliSessionId` is a LOOKUP HANDLE ONLY and collides: on the same store
// one cliSessionId was shared by two different tasks. Keying on it renders one
// task's conversation under another task's title.
//
// ON THE RULE THIS MODULE DELIBERATELY DOES NOT USE. An earlier spike derived a
// predicate for "does this task have a transcript" from `transcriptUnavailable`
// and `completedTurns`, and it scored 0 mispredictions on 29 tasks. Re-measured
// on the same machine four days later at 33 tasks, it got 2 wrong — both tasks
// with a real transcript (45 and 17 rows) that had never COMPLETED a turn, so
// `completedTurns` was absent. Predicting from turn counts fails exactly for the
// in-flight task, which is the one a live UI most needs to show.
//
// So this module resolves rather than predicts: `transcriptUnavailable` is
// honoured as a fast negative (0 counterexamples in 33), and otherwise we look
// for the file. 8 of 33 tasks have a cliSessionId and no file — that is a normal
// state, not an error.

import { promises as fs, type Dirent } from 'node:fs'
import { AppendFileCache } from '../append-file-cache'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Where Claude Desktop stores one JSON file per task. */
export const DEFAULT_SESSIONS_DIR = join(
  homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions',
)

/** Where the embedded CLI stores conversations, keyed by encoded cwd. */
export const DEFAULT_PROJECTS_DIR = join(homedir(), '.claude', 'projects')

/** A task as Claude Desktop records it on disk. */
export interface ClaudeDesktopTask {
  /** PRIMARY KEY. Stable, and unique across the store. */
  sessionId: string
  /** Handle used to find the transcript. NOT unique — never key on it. */
  cliSessionId: string | null
  title: string | null
  model: string | null
  /** Working directory; also how the transcript directory is derived. */
  cwd: string
  /** Where the task was started, when it later moved (e.g. into a worktree). */
  originCwd: string | null
  worktreePath: string | null
  /** 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' — affects whether
   *  this task can ever raise an approval prompt at all. */
  permissionMode: string | null
  /** Absent in the file for a task that has not finished a turn. */
  completedTurns: number
  createdAt: number
  lastActivityAt: number
  /** When the user last had this conversation OPEN in Claude Desktop.
   *
   *  The newest one across the store is the conversation on screen right now,
   *  which is the only way to attribute a permission prompt to a task: the
   *  prompt exists in the window, not on disk, and only one conversation is
   *  ever addressable (AXWindows is empty on this app). Absent on tasks never
   *  opened — 14 of 33 carry it. */
  lastFocusedAt: number
  archived: boolean
  /** The app's own assertion that no transcript exists. Honoured as a negative. */
  transcriptUnavailable: boolean
}

/**
 * One entry of a Claude conversation.
 *
 * Roles are deliberately the SAME vocabulary as CodexTurn, so the task card can
 * render either backend without a per-provider branch:
 *
 *   user        what you asked
 *   commentary  extended thinking
 *   tool        a step it ran — name, input, and result
 *   assistant   prose it wrote back
 */
export interface ClaudeTurn {
  role: 'user' | 'assistant' | 'commentary' | 'tool'
  text: string
  /** tool: the tool's name, e.g. "Bash", "Edit". */
  title?: string
  /** tool: the input it was called with, JSON-encoded. */
  code?: string
  /** tool: what came back (truncated). */
  output?: string
  /** tool: false when the result was flagged an error. */
  ok?: boolean
}

export interface ClaudeSnapshot {
  /** Last prose the assistant wrote — the headline for a card. */
  lastAgentMessage: string | null
  /** Last few turns, oldest→newest. */
  turns: ClaudeTurn[]
  /** ms since epoch of the newest row we could date (0 when unknown). */
  updatedAt: number
  /** Total user messages — a turn count that does not depend on completion. */
  userMessages: number
  /**
   * Tool calls with no matching result.
   *
   * The same caveat as Codex applies, for the same reason: an unmatched call is
   * what a turn waiting on a permission prompt looks like on disk, but a slow
   * command looks identical. It is a candidate signal, never a conclusion —
   * pair it with "and the file stopped growing", or better, read the live
   * prompt from AX where it actually exists.
   */
  pendingToolCalls: number
  /** Name of the oldest unmatched call, for a "waiting on…" line. */
  pendingToolName: string | null
}

/**
 * Encode a cwd the way the CLI names its project directory.
 *
 * Measured against every transcript on a real machine: `/`, `.` AND `_` all
 * become `-`. Deriving this from `/` alone resolved 5 of 11 transcripts —
 * `calorify_ai` lives at `calorify-ai`, and `/.claude/` at `--claude-`. With all
 * three, 11 of 11 resolve.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/._]/g, '-')
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

/** Map one raw `local_*.json` object onto ClaudeDesktopTask. Null if it has no
 *  sessionId — without the primary key there is nothing we can safely show. */
export function toTask(raw: Record<string, unknown>): ClaudeDesktopTask | null {
  const sessionId = str(raw.sessionId)
  if (!sessionId) return null
  const cwd = str(raw.cwd) ?? str(raw.originCwd) ?? ''
  return {
    sessionId,
    cliSessionId: str(raw.cliSessionId),
    title: str(raw.title),
    model: str(raw.model),
    cwd,
    originCwd: str(raw.originCwd),
    worktreePath: str(raw.worktreePath),
    permissionMode: str(raw.permissionMode),
    completedTurns: num(raw.completedTurns),
    createdAt: num(raw.createdAt),
    lastActivityAt: num(raw.lastActivityAt),
    lastFocusedAt: num(raw.lastFocusedAt),
    archived: raw.isArchived === true,
    transcriptUnavailable: raw.transcriptUnavailable === true,
  }
}

/**
 * Every task in the store, newest activity first.
 *
 * The layout is `<sessionsDir>/<a>/<b>/local_<uuid>.json` — two levels of
 * opaque uuid directories. We walk rather than glob a fixed depth so an extra
 * level added by a future build degrades to "found nothing new" instead of
 * throwing. A file that will not parse is skipped, not fatal: one corrupt task
 * must not blank the whole list.
 */
export async function listTasks(sessionsDir = DEFAULT_SESSIONS_DIR): Promise<ClaudeDesktopTask[]> {
  const out: ClaudeDesktopTask[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p, depth + 1)
      } else if (e.name.startsWith('local_') && e.name.endsWith('.json')) {
        try {
          const raw = JSON.parse(await fs.readFile(p, 'utf8')) as Record<string, unknown>
          const t = toTask(raw)
          if (t) out.push(t)
        } catch {
          // Unreadable or mid-write. Skip this one task.
        }
      }
    }
  }
  await walk(sessionsDir, 0)
  out.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return out
}

/**
 * Locate a task's transcript, or null.
 *
 * Tries the directories the task itself names, in the order most likely to be
 * right, then falls back to scanning every project directory for the file. The
 * fallback exists because cwd is not guaranteed to be where the conversation
 * was actually written — a task that moved into a worktree records the new cwd
 * while its transcript stays where it started.
 */
export async function findTranscript(
  task: ClaudeDesktopTask,
  projectsDir = DEFAULT_PROJECTS_DIR,
): Promise<string | null> {
  if (task.transcriptUnavailable || !task.cliSessionId) return null
  const file = `${task.cliSessionId}.jsonl`

  const bases = [task.cwd, task.worktreePath, task.originCwd].filter(Boolean) as string[]
  for (const base of bases) {
    const p = join(projectsDir, encodeProjectDir(base), file)
    try {
      await fs.access(p)
      return p
    } catch {
      // try the next candidate
    }
  }

  // Fallback: the named directories were wrong. Scan.
  let dirs: string[]
  try {
    dirs = await fs.readdir(projectsDir)
  } catch {
    return null
  }
  for (const d of dirs) {
    const p = join(projectsDir, d, file)
    try {
      await fs.access(p)
      return p
    } catch {
      // keep scanning
    }
  }
  return null
}

const MAX_OUTPUT = 2000

/** tool_result content is either a string or a list of blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
        ? (b as { text: string }).text
        : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * Parse a transcript JSONL into the snapshot a card renders from.
 *
 * Row types observed across the 12 largest transcripts on a real machine:
 * assistant, user, last-prompt, permission-mode, mode, ai-title, system,
 * file-history-snapshot, attachment, agent-name, queue-operation, custom-title.
 * Only `user` and `assistant` carry conversation; everything else is app
 * bookkeeping and is ignored rather than guessed at.
 *
 * Content blocks observed: text, thinking, tool_use, tool_result, image, and a
 * bare string (user messages are usually a plain string, not a block list).
 *
 * SIDECHAINS ARE EXCLUDED. `isSidechain` rows are a subagent's own conversation.
 * Inlining them interleaves a different agent's turns into the main thread.
 */
export function parseTranscript(text: string, turnLimit = 8): ClaudeSnapshot {
  const turns: ClaudeTurn[] = []
  let lastAgentMessage: string | null = null
  let updatedAt = 0
  let userMessages = 0
  /** tool_use_id → index in `turns`, so a later result can fill in its output. */
  const openCalls = new Map<string, number>()

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue // a partially-written trailing line is normal on a live file
    }
    if (row.isSidechain === true) continue

    const ts = Date.parse(String(row.timestamp ?? ''))
    if (Number.isFinite(ts)) updatedAt = Math.max(updatedAt, ts)

    const msg = row.message
    if (!msg || typeof msg !== 'object') continue
    const role = (msg as { role?: unknown }).role
    const content = (msg as { content?: unknown }).content

    if (role === 'user') {
      // A user row carrying tool_result blocks is the RUNTIME reporting back,
      // not the human speaking. Attribute those to their call.
      if (Array.isArray(content)) {
        let spoke = false
        for (const b of content) {
          if (!b || typeof b !== 'object') continue
          const block = b as Record<string, unknown>
          if (block.type === 'tool_result') {
            const idx = openCalls.get(String(block.tool_use_id))
            if (idx !== undefined) {
              const t = turns[idx]
              t.output = resultText(block.content).slice(0, MAX_OUTPUT)
              t.ok = block.is_error !== true
              openCalls.delete(String(block.tool_use_id))
            }
          } else if (block.type === 'text' && typeof block.text === 'string') {
            spoke = true
            turns.push({ role: 'user', text: block.text })
          }
        }
        if (spoke) userMessages++
      } else if (typeof content === 'string' && content) {
        userMessages++
        turns.push({ role: 'user', text: content })
      }
      continue
    }

    if (role !== 'assistant' || !Array.isArray(content)) continue
    for (const b of content) {
      if (!b || typeof b !== 'object') continue
      const block = b as Record<string, unknown>
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        lastAgentMessage = block.text
        turns.push({ role: 'assistant', text: block.text })
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        turns.push({ role: 'commentary', text: block.thinking })
      } else if (block.type === 'tool_use') {
        const name = typeof block.name === 'string' ? block.name : 'tool'
        let code = ''
        try {
          code = JSON.stringify(block.input ?? {})
        } catch {
          code = ''
        }
        openCalls.set(String(block.id), turns.length)
        turns.push({ role: 'tool', text: name, title: name, code })
      }
    }
  }

  // Oldest unmatched call — Map preserves insertion order.
  const firstOpen = openCalls.values().next()
  const pendingToolName = firstOpen.done ? null : (turns[firstOpen.value]?.title ?? null)

  return {
    lastAgentMessage,
    turns: turnLimit > 0 ? turns.slice(-turnLimit) : turns,
    updatedAt,
    userMessages,
    pendingToolCalls: openCalls.size,
    pendingToolName,
  }
}

/** Read + parse a task's transcript. No transcript ⇒ an empty snapshot, which
 *  is a normal state (8 of 33 tasks on a real store), not an error. */
export async function readTranscript(
  task: ClaudeDesktopTask,
  projectsDir = DEFAULT_PROJECTS_DIR,
  turnLimit = 8,
): Promise<ClaudeSnapshot> {
  const path = await findTranscript(task, projectsDir)
  if (!path) return EMPTY_SNAPSHOT
  try {
    const read = await transcriptFiles.read(path)
    if (read.missing) return EMPTY_SNAPSHOT
    const hit = transcriptSnapshots.get(path)
    if (!read.changed && hit?.limit === turnLimit) return hit.snapshot
    const snapshot = parseTranscript(read.text, turnLimit)
    transcriptSnapshots.set(path, { limit: turnLimit, snapshot })
    if (transcriptSnapshots.size > 64) {
      transcriptSnapshots.delete(transcriptSnapshots.keys().next().value as string)
    }
    return snapshot
  } catch {
    return EMPTY_SNAPSHOT
  }
}

const transcriptFiles = new AppendFileCache()
const transcriptSnapshots = new Map<string, { limit: number; snapshot: ClaudeSnapshot }>()

const EMPTY_SNAPSHOT: ClaudeSnapshot = {
  lastAgentMessage: null,
  turns: [],
  updatedAt: 0,
  userMessages: 0,
  pendingToolCalls: 0,
  pendingToolName: null,
}
