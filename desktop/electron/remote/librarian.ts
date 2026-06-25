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
import { sharedSkillsDir, skillsIndex, readUserProfile, userProfilePath } from './skills'
import type { ExecutorFactory } from './executor'
import { settleRepl } from './repl-settle'

const log = createLogger('librarian')

export interface RecipeSuggestion {
  /** Originating task id (for logging/correlation). */
  taskId: string
  /** The cleaned intent the doer accomplished. */
  intent: string
  /** Absolute path to the doer's OPTIONAL recipe-suggestion scratch file (the
   *  doer may jot an insight here, but the librarian no longer depends on it —
   *  it curates from what the task actually did). */
  scratchPath?: string
  /** The doer's per-task working dir (for the librarian session base). */
  cwd: string
  /** What the task DID — so the librarian can judge durable knowledge itself
   *  rather than relying on the doer to pre-distill it. */
  summary?: string
  detail?: string
  category?: string
  /** A cleaned tail of the task transcript (the doer's real actions/tools). */
  transcript?: string
}

export interface LibrarianOpts {
  executorFactory: ExecutorFactory
  baseDir?: string
  pollMs?: number
  /** Last-resort backstop: kill a wedged session after this long so it can't jam
   *  the serialized queue forever. Generous — the librarian is async/off the hot
   *  path, so this should never fire in normal operation. Default 5 min. */
  timeoutMs?: number
  /** If the librarian's status file hasn't changed for this long, nudge it with
   *  an Enter — a Claude Code session occasionally lands one Enter short of
   *  submitting (same quirk the doer/router confirm-Enter for). Default 20s. */
  nudgeMs?: number
  /** ms to wait after accepting the folder-trust prompt for the REPL to boot. */
  trustAcceptMs?: number
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
      timeoutMs: opts.timeoutMs ?? 5 * 60_000,
      nudgeMs: opts.nudgeMs ?? 20_000,
      trustAcceptMs: opts.trustAcceptMs ?? 2000,
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

  /** Spawn one librarian session to curate the user's durable memory. */
  private async runOne(s: RecipeSuggestion): Promise<void> {
    const llog = log.child({ taskId: s.taskId })
    const t0 = this.clock()
    const skillsDir = sharedSkillsDir(this.opts.baseDir || undefined)
    const profilePath = userProfilePath(this.opts.baseDir || undefined)
    await fs.mkdir(skillsDir, { recursive: true })

    // The librarian gets its own working dir + status file under the task dir.
    const libCwd = join(s.cwd, 'librarian')
    const statusPath = join(libCwd, 'status.json')
    await scaffoldStatusFile(statusPath)
    await installContract(libCwd)

    const index = await skillsIndex(this.opts.baseDir || undefined)
    const profile = await readUserProfile(this.opts.baseDir || undefined)
    llog.event('librarian-start', { skillsDir, profilePath, existingSkills: index.length, hasProfile: !!profile.trim() })

    // Accumulate the PTY output so the settle loop can observe when the REPL is
    // actually at its idle prompt (capped — we only ever read the tail).
    const OUT_CAP = 64_000
    let outBuf = ''
    const ex = this.opts.executorFactory()
    ex.onData((c) => {
      outBuf += c
      if (outBuf.length > OUT_CAP) outBuf = outBuf.slice(-OUT_CAP)
      llog.debug('librarian-pty', { chunk: c })
    })
    await ex.spawn({ cwd: libCwd, env: process.env, taskId: `${s.taskId}-librarian` })
    await ex.isReady()
    // Clear the folder-trust prompt (fresh dir) and reach the idle REPL using the
    // SAME observed-output settle loop as the doer — never a blind timer (which
    // raced and left the prompt unsubmitted, wedging the session) and NEVER Esc
    // (Esc = "No, exit" → quits Claude). Only then dispatch, so the prompt can't
    // land mid-dialog/mid-paint. Gated on trustAcceptMs>0 so the no-output test
    // fake dispatches instantly.
    if (this.opts.trustAcceptMs > 0) {
      await settleRepl({
        getOutput: () => outBuf,
        isAlive: () => ex.alive,
        sendEnter: () => ex.write('\r'),
        onEvent: (event, fields) => llog.event(event, fields),
      })
    }

    ex.writeStdin(this.buildPrompt(s, skillsDir, profilePath, statusPath, index, profile))

    // Wait (bounded) for the librarian to finish, signalled via its status file.
    // A stuck-nudge fires an Enter if the status file stalls — a Claude Code
    // session sometimes lands one Enter short of submitting. The timeout is only
    // a last-resort backstop so a wedged session can't jam the serialized queue.
    const deadline = this.clock() + this.opts.timeoutMs
    let done = false
    let lastNudge = this.clock()
    while (this.clock() < deadline) {
      await new Promise((r) => setTimeout(r, this.opts.pollMs))
      const st = await readStatus(statusPath)
      if (st && (st.state === 'done' || st.state === 'failed')) {
        done = true
        llog.event('librarian-finished', { state: st.state, summary: st.result?.summary })
        break
      }
      if (this.clock() - lastNudge >= this.opts.nudgeMs && ex.alive) {
        lastNudge = this.clock()
        ex.write('\r') // unstick a one-Enter-short session
        llog.event('librarian-nudge', { taskId: s.taskId, elapsedMs: this.clock() - t0 })
      }
    }
    if (!done) llog.warn('librarian backstop-timeout — closing wedged session', { ms: this.opts.timeoutMs })
    ex.kill()
    // Phase timing: how long the librarian held this submission end-to-end.
    llog.event('phase-timing', { taskId: s.taskId, phase: 'librarian', ms: this.clock() - t0, finished: done })
  }

  /** The curation CHARTER for the librarian session — the heart of the system.
   *  It curates DURABLE knowledge that lets future terse commands succeed, with
   *  a hard bias toward no-op; it is NOT a step-logger. */
  private buildPrompt(
    s: RecipeSuggestion,
    skillsDir: string,
    profilePath: string,
    statusPath: string,
    index: Array<{ name: string; description: string }>,
    profile: string,
  ): string {
    const indexLines = index.length
      ? index.map((i) => `  - ${i.name}: ${i.description || '(no description)'}`).join('\n')
      : '  (the skills library is empty)'
    return [
      `[Unmute Remote — librarian]`,
      `You curate the user's long-term MEMORY so that, over time, they can say`,
      `LESS and still get tasks done. You learn from a task that just finished.`,
      `You are the ONLY writer to this memory. Be conservative: MOST tasks teach`,
      `nothing new — when in doubt, NO-OP.`,
      ``,
      `You run AUTONOMOUSLY in the background — there is NO user watching and no`,
      `one to answer you. NEVER ask a question, NEVER pause for confirmation, and`,
      `NEVER wait for input. You have full authority to write, update, or delete`,
      `in the memory yourself. If something is unclear, make the smallest safe`,
      `change or no-op and finish — but never block waiting for an answer.`,
      ``,
      `── The task that just finished ──`,
      `Intent: ${s.intent}`,
      s.category ? `Category: ${s.category}` : null,
      s.summary ? `Result summary: ${s.summary}` : null,
      s.detail ? `Result detail: ${s.detail}` : null,
      s.scratchPath ? `Optional doer note (may be empty/absent): ${s.scratchPath}` : null,
      s.transcript ? `\nWhat the doer actually did (transcript tail):\n${s.transcript}` : null,
      ``,
      `── The two memory stores you maintain ──`,
      `1. USER PROFILE — durable FACTS & PREFERENCES about this user: which`,
      `   accounts they use (and for what), preferred apps/services, main email,`,
      `   key people, naming conventions, defaults. This is what lets "open my`,
      `   show" or "any meetings today" work without them specifying where/which.`,
      `   File: ${profilePath} (plain markdown, sectioned by topic).`,
      profile.trim() ? `   Current profile:\n${profile}` : `   The profile is currently empty.`,
      `2. SKILLS — reusable METHODS for a CLASS of task, capturing the reliable`,
      `   approach + the non-obvious GOTCHA (e.g. "use get_page_text not`,
      `   screenshots, which hide late events"). File per skill in ${skillsDir},`,
      `   OpenClaw format: YAML frontmatter (\`name\` + a SPECIFIC \`description\` —`,
      `   the description is what future tasks match on) then a markdown body.`,
      `   Existing skills (name: description):`,
      indexLines,
      ``,
      `── What to capture (and what NOT to) ──`,
      `- Capture only DURABLE knowledge: a user fact/preference, or a reusable`,
      `  method + its gotcha. NEVER store brittle UI steps ("click here, scroll`,
      `  there") — they break and add noise.`,
      `- If nothing was non-obvious — the task was simple, or any competent model`,
      `  would do it right next time — NO-OP. Simplicity is the common case.`,
      `- CONSOLIDATE, don't fragment: prefer UPDATING the profile or an existing`,
      `  skill over creating a new one. One skill per task-CLASS, kept coarse.`,
      `  Delete a skill only if it's now wrong or superseded.`,
      `- A user fact (accounts, prefs, contacts) goes in the PROFILE, not a skill.`,
      ``,
      `── Decide, then act ──`,
      `Choose: update the profile, create/update/delete a skill, or no-op. Make`,
      `at most the minimal change. Use REAL identifiers (account indexes, paths,`,
      `handles) but no pixel-level steps.`,
      ``,
      `When finished, write your status file (${statusPath}) state=done with a`,
      `one-line result.summary of exactly what you changed — or "no-op: <reason>"`,
      `if nothing was worth keeping. Follow the loaded Unmute contract for writes.`,
    ].filter((l): l is string => l !== null).join('\n')
  }
}
