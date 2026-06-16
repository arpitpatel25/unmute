// Unmute Remote — the librarian (PRD §9): concurrency-safe recipe memory.
//
// Recipe upkeep is SEPARATE from task execution and happens AFTER a task. The
// doer writes a recipe *suggestion* to its own scratch file (never the shared
// book). The librarian — a single, SERIALIZED, one-shot Claude Code session —
// is the ONLY writer to the shared skill library. This makes the write race
// structurally impossible (WAL / single-applier pattern, §9.2).
//
// Rules implemented (§9.3):
//   * Serialized: only one librarian runs at a time, ever. Submissions while
//     one is running are queued and drained.
//   * Lazy: only fires when there's a pending suggestion.
//   * Async + invisible: runs after the user already got their "done".
//   * Same billing: another interactive `claude` session (no -p, no API key).

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from './log'
import { scaffoldStatusFile, readStatus } from './status-file'
import { installContract } from './contract/installer'
import { sharedSkillsDir, listSharedSkills } from './skills'
import type { ExecutorFactory } from './executor'

const log = createLogger('librarian')

export interface RecipeSuggestion {
  /** Originating task id (for logging/correlation). */
  taskId: string
  /** The cleaned intent the doer accomplished. */
  intent: string
  /** Absolute path to the doer's recipe-suggestion scratch file. */
  scratchPath: string
  /** The doer's per-task working dir (for the librarian session base). */
  cwd: string
}

export interface LibrarianOpts {
  executorFactory: ExecutorFactory
  baseDir?: string
  pollMs?: number
  /** Max time to wait for one librarian session to finish before giving up. */
  timeoutMs?: number
  now?: () => number
}

export class Librarian {
  private queue: RecipeSuggestion[] = []
  private running = false
  private readonly opts: Required<Omit<LibrarianOpts, 'now'>> & Pick<LibrarianOpts, 'now'>

  constructor(opts: LibrarianOpts) {
    this.opts = {
      executorFactory: opts.executorFactory,
      baseDir: opts.baseDir ?? '',
      pollMs: opts.pollMs ?? 1000,
      timeoutMs: opts.timeoutMs ?? 120_000,
      now: opts.now,
    }
  }

  private clock(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  get pending(): number {
    return this.queue.length + (this.running ? 1 : 0)
  }

  /**
   * Submit a doer's recipe suggestion. Returns a promise that resolves when
   * THIS submission has been processed (useful for tests; callers normally
   * fire-and-forget since the user already has their result).
   */
  async submit(s: RecipeSuggestion): Promise<void> {
    log.event('suggestion-submitted', { taskId: s.taskId, intent: s.intent })
    this.queue.push(s)
    await this.drain()
  }

  /** Process the queue one-at-a-time (serialized single writer, §9.2/§9.3). */
  private async drain(): Promise<void> {
    if (this.running) return // a drain loop is already active
    this.running = true
    try {
      while (this.queue.length > 0) {
        const s = this.queue.shift()!
        try {
          await this.runOne(s)
        } catch (e) {
          log.error('librarian run failed (suggestion dropped)', { taskId: s.taskId, error: (e as Error).message })
        }
      }
    } finally {
      this.running = false
    }
  }

  /** Spawn one librarian session to apply a single suggestion to the book. */
  private async runOne(s: RecipeSuggestion): Promise<void> {
    const llog = log.child({ taskId: s.taskId })
    const skillsDir = sharedSkillsDir(this.opts.baseDir || undefined)
    await fs.mkdir(skillsDir, { recursive: true })

    // The librarian gets its own working dir + status file under the task dir.
    const libCwd = join(s.cwd, 'librarian')
    const statusPath = join(libCwd, 'status.json')
    await scaffoldStatusFile(statusPath)
    await installContract(libCwd)

    const existing = await listSharedSkills(this.opts.baseDir || undefined)
    llog.event('librarian-start', { skillsDir, existingSkills: existing.length })

    const ex = this.opts.executorFactory()
    ex.onData((c) => llog.debug('librarian-pty', { chunk: c }))
    await ex.spawn({ cwd: libCwd, env: process.env, taskId: `${s.taskId}-librarian` })
    await ex.isReady()

    ex.writeStdin(this.buildPrompt(s, skillsDir, statusPath, existing))

    // Wait (bounded) for the librarian to finish, signalled via its status file.
    const deadline = this.clock() + this.opts.timeoutMs
    let done = false
    while (this.clock() < deadline) {
      await new Promise((r) => setTimeout(r, this.opts.pollMs))
      const st = await readStatus(statusPath)
      if (st && (st.state === 'done' || st.state === 'failed')) {
        done = true
        llog.event('librarian-finished', { state: st.state, summary: st.result?.summary })
        break
      }
    }
    if (!done) llog.warn('librarian timed out — closing session', {})
    ex.kill()
  }

  /** The curation instruction for the librarian session. */
  private buildPrompt(s: RecipeSuggestion, skillsDir: string, statusPath: string, existing: string[]): string {
    return [
      `[Unmute Remote — librarian task]`,
      `You are the recipe librarian. A task just completed and proposed a recipe.`,
      ``,
      `Task intent: ${s.intent}`,
      `The doer's recipe suggestion is in: ${s.scratchPath}`,
      `The shared skill/recipe library is the directory: ${skillsDir}`,
      existing.length ? `Existing recipe files: ${existing.join(', ')}` : `The library is currently empty.`,
      ``,
      `Decide: create a new recipe, update an existing one, or no-op (if the`,
      `suggestion adds nothing). If you create/update, write a skill file into`,
      `${skillsDir} in OpenClaw skill-file format: YAML frontmatter with a`,
      `precise, specific \`name\` and \`description\` (the description is what`,
      `auto-discovery matches against — make it specific), then a body of`,
      `concrete steps with REAL paths/commands/identifiers (not vague prose).`,
      `Prefer ONE recipe per clear task-type (start coarse).`,
      ``,
      `When finished, write your status file (${statusPath}) state=done with a`,
      `one-line result.summary of what you changed (or "no-op"). Follow the`,
      `loaded Unmute contract for status-file writes.`,
    ].join('\n')
  }
}
