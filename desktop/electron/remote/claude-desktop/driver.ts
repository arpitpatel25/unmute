// Unmute Remote — Claude desktop backend driver (READ HALF).
//
// Deliberately mirrors CodexDesktopDriver's shape — isInstalled / availability /
// snapshot / watch — so TaskManager wires this backend the same way it wires
// Codex, rather than growing a second, differently-shaped integration.
//
// It is NOT the same underneath, and the difference is the interesting part:
//
//   Codex        every read goes over CDP to a live app.
//   Claude       every read here is a FILE. Nothing in this module talks to
//                Claude Desktop at all.
//
// That was not a preference. Claude Desktop does not honour
// --remote-debugging-port: measured 2026-07-31, the switch is accepted on the
// command line and no DevTools socket is ever opened (no listening port in the
// process tree, no DevToolsActivePort file), while ChatGPT.app on the same
// machine with the same technique opens 9302 immediately. So there is no CDP
// channel to this app, and the parts that genuinely need the live UI — the
// pending permission prompt, run status — come from the accessibility tree in
// a separate module.
//
// The upside of files: THIS driver works with Claude Desktop closed, needs no
// launch flag, and cannot steal focus. Everything in here is safe to poll.
//
// What is NOT here, on purpose: creating a task, sending text, answering a
// prompt. All three require the app frontmost (four independent backgrounded
// routes were tested and all failed silently), so they belong behind a single
// serialized actuation queue rather than being callable from anywhere.

import { promises as fs, watch as fsWatch } from 'node:fs'
import {
  listTasks, readTranscript, findTranscript,
  DEFAULT_SESSIONS_DIR, DEFAULT_PROJECTS_DIR,
  type ClaudeDesktopTask, type ClaudeSnapshot, type ClaudeTurn,
} from './sessions'

/** Where the app lives. Same convention as CODEX_APP_PATH. */
export const CLAUDE_APP_PATH = '/Applications/Claude.app'

export type ClaudeAvailabilityReason = 'not-installed'

export interface ClaudeAvailability {
  ok: boolean
  reason?: ClaudeAvailabilityReason
}

/** A task plus whatever its transcript says — one card's worth of state. */
export interface ClaudeTaskView {
  task: ClaudeDesktopTask
  snapshot: ClaudeSnapshot
}

export interface ClaudeDriverDeps {
  appPath?: string
  sessionsDir?: string
  projectsDir?: string
  /** Injectable for tests; defaults to fs.access on appPath. */
  appInstalled?: (appPath: string) => Promise<boolean>
}

export class ClaudeDesktopDriver {
  private readonly appPath: string
  private readonly sessionsDir: string
  private readonly projectsDir: string
  private taskCache: { at: number; tasks: ClaudeDesktopTask[] } | null = null

  constructor(private readonly deps: ClaudeDriverDeps = {}) {
    this.appPath = deps.appPath ?? CLAUDE_APP_PATH
    this.sessionsDir = deps.sessionsDir ?? DEFAULT_SESSIONS_DIR
    this.projectsDir = deps.projectsDir ?? DEFAULT_PROJECTS_DIR
  }

  async isInstalled(): Promise<boolean> {
    if (this.deps.appInstalled) return this.deps.appInstalled(this.appPath)
    try {
      await fs.access(this.appPath)
      return true
    } catch {
      return false
    }
  }

  /**
   * Can this backend be READ right now?
   *
   * Installed is the whole test, and that is a real difference from Codex
   * rather than a shortcut: the store is on disk, so reading works while the
   * app is shut. There is no 'not-running' or 'not-armed' state for reading.
   *
   * ACTUATION has stricter preconditions — the app must be launched by us with
   * --force-renderer-accessibility and must have been activated at least once,
   * or the tree is a 185-node stub. Those belong to the actuation path, and
   * reporting them here would make the whole backend look unavailable when the
   * part that exists today works fine.
   */
  async availability(): Promise<ClaudeAvailability> {
    return (await this.isInstalled()) ? { ok: true } : { ok: false, reason: 'not-installed' }
  }

  /** Every task in Claude Desktop's store, newest activity first.
   *
   *  Unlike Codex — where Unmute only knows threads it created — this
   *  enumerates the user's EXISTING conversations, because they are simply
   *  files. That is what makes "see my Claude Desktop chats in Unmute"
   *  possible at all. */
  async list(): Promise<ClaudeDesktopTask[]> {
    const now = Date.now()
    if (this.taskCache && now - this.taskCache.at < 5_000) return this.taskCache.tasks
    const tasks = await listTasks(this.sessionsDir)
    this.taskCache = { at: now, tasks }
    return tasks
  }

  /**
   * The conversation Claude Desktop currently has OPEN, by newest lastFocusedAt.
   *
   * Needed because a permission prompt lives in the window and names no task.
   * Only one conversation is addressable at a time, so the focused one is the
   * only task a visible prompt can belong to. Null when nothing in the store
   * has ever been focused, which is honest rather than a guess.
   */
  async focused(): Promise<ClaudeDesktopTask | null> {
    let best: ClaudeDesktopTask | null = null
    for (const t of await this.list()) {
      if (t.lastFocusedAt > 0 && (!best || t.lastFocusedAt > best.lastFocusedAt)) best = t
    }
    return best
  }

  /** One task by its primary key, or null if it is gone from the store. */
  async find(sessionId: string): Promise<ClaudeDesktopTask | null> {
    const all = await this.list()
    return all.find((t) => t.sessionId === sessionId) ?? null
  }

  /** Task + conversation for one card. */
  async snapshot(sessionId: string, turnLimit = 8): Promise<ClaudeTaskView | null> {
    const task = await this.find(sessionId)
    if (!task) return null
    return { task, snapshot: await readTranscript(task, this.projectsDir, turnLimit) }
  }

  /**
   * Call back when a task's transcript changes.
   *
   * Same contract as the Codex watcher, including its failure mode: fs.watch
   * coalesces and can miss events, so this is a LATENCY SHORTCUT and never the
   * only path — the caller must keep polling as the correctness backstop.
   *
   * Returns a no-op disposer when there is nothing to watch yet (a task whose
   * transcript has not been created), so the caller never has to special-case
   * a task that has not started.
   */
  async watch(sessionId: string, onChange: () => void): Promise<() => void> {
    const task = await this.find(sessionId)
    if (!task) return () => {}
    const path = await findTranscript(task, this.projectsDir)
    if (!path) return () => {}
    try {
      let timer: NodeJS.Timeout | null = null
      const w = fsWatch(path, () => {
        // Debounce: a single append can emit several events.
        if (timer) clearTimeout(timer)
        timer = setTimeout(onChange, 120)
      })
      return () => {
        if (timer) clearTimeout(timer)
        w.close()
      }
    } catch {
      return () => {}
    }
  }
}

export type { ClaudeDesktopTask, ClaudeSnapshot, ClaudeTurn }
