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
import { readUserProfile, userProfilePath } from './skills'
import type { ExecutorFactory } from './executor'
import { settleRepl } from './repl-settle'
import { locateTranscript, reduceTranscript } from './trace-reducer'
import { listRecipes, recipesDir, graduatedDir } from './recipe-store'

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
  /** Recipes injected into the doer's run — the librarian judges these. */
  injectedRecipes?: Array<{ name: string; tier: 'nursery' | 'skill'; surface: string }>
  /** Whether the task run completed successfully or failed. */
  outcome?: 'done' | 'failed'
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
  /** Whether the librarian may write directly to the recipe/skills store. When
   *  false (default, calibration mode) it writes a proposal.json instead. */
  writeEnabled?: boolean
  now?: () => number
}

export interface LibrarianPromptInput {
  intent: string
  outcome: 'done' | 'failed'
  injectedRecipes: Array<{ name: string; tier: 'nursery' | 'skill'; surface: string }>
  reducedTrace: string
  existing: Array<{ name: string; surface: string; confidence: string; description: string }>
  profile: string
  writeEnabled: boolean
  recipesDir: string
  skillsDir: string
  proposalPath: string
  statusPath: string
}

export function buildLibrarianPrompt(i: LibrarianPromptInput): string {
  const injected = i.injectedRecipes.length
    ? i.injectedRecipes.map((r) => `  - ${r.name} (${r.tier}, surface=${r.surface})`).join('\n')
    : '  (none injected this run)'
  const index = i.existing.length
    ? i.existing.map((e) => `  - ${e.name} [${e.confidence}, ${e.surface}]: ${e.description}`).join('\n')
    : '  (memory is empty)'
  const writeRules = i.writeEnabled
    ? [
      `WRITE MODE: apply your decision directly to the store.`,
      `- Nursery (low/medium) recipes live under ${i.recipesDir}/<surface>/<name>.md`,
      `- Graduated (high) recipes live under ${i.skillsDir}/<surface>/<name>.md`,
      `- Promote/demote = move the file between those folders AND set the confidence field to match.`,
      `- New knowledge is ALWAYS created low-confidence in ${i.recipesDir}/<surface>/ — NEVER directly in ${i.skillsDir}/.`,
    ].join('\n')
    : [
      `READ-ONLY MODE (calibration): DO NOT modify, create, move, or delete ANY file under`,
      `${i.recipesDir} or ${i.skillsDir}, and DO NOT edit the profile.`,
      `Instead write your INTENDED decision as JSON to ${i.proposalPath} with shape:`,
      `{ "action": "no-op|create|promote|demote|update-counters", "name": "...", "surface": "...",`,
      `  "from_confidence": "low|medium|high|null", "to_confidence": "low|medium|high|null", "reason": "..." }`,
    ].join('\n')

  return [
    `[Unmute Remote — librarian]`,
    `You curate the user's long-term MEMORY so future terse commands succeed. You are the`,
    `ONLY writer. Be conservative: MOST runs change NOTHING — when in doubt, NO-OP.`,
    ``,
    `You run AUTONOMOUSLY — no user is watching. NEVER ask a question, NEVER wait for input.`,
    `Make the smallest safe change (or no-op) and finish.`,
    ``,
    `── The run that just finished ──`,
    `Intent: ${i.intent}`,
    `Outcome: ${i.outcome}`,
    `Recipes injected into this run:`,
    injected,
    ``,
    `What the executor ACTUALLY did (reduced action trace):`,
    i.reducedTrace || '  (no trace available)',
    ``,
    `── How to judge confidence (the dials) ──`,
    `Judge each INJECTED recipe by whether its claims were corroborated or CONTRADICTED by the`,
    `trace — NOT by whether the task merely succeeded or failed.`,
    `Only the HARD sections move confidence: "Invariants", "Definition of done", and named`,
    `structural facts (enumerations, locations, stable identifiers, documented gotchas).`,
    `The SOFT sections — "Defaults" and "Procedure" — are DESIGNED to be adapted; a deviation`,
    `there is NEVER a contradiction.`,
    `- CORROBORATED: the trace exercised a hard claim and it held -> runs_confirmed += 1, stamp`,
    `  last_used + last_verified. If thresholds are met, PROMOTE one tier`,
    `  (low->medium after 2 confirmations; medium->high after 3, both with no contradiction).`,
    `- CONTRADICTED: the trace shows a hard claim was FALSE (a named fact didn't hold and the`,
    `  model had to discover a different one, or a Definition-of-done invariant failed) ->`,
    `  DEMOTE one tier, runs_contradicted += 1, REWRITE the wrong part as a fresh LOW-confidence`,
    `  claim, re-hedge the phrasing.`,
    `- AMBIGUOUS (deviation only in soft sections, recipe not really exercised, or failure`,
    `  unrelated to the recipe — auth/network/novel sub-task) -> NO-OP (at most stamp last_used).`,
    ``,
    `── When to CREATE a new recipe (high bar) ──`,
    `Create a NEW low-confidence nursery recipe ONLY if ALL hold: (a) the run surfaced a`,
    `DURABLE, environmental fact worth a real Invariant or Known-failure-mode (not transient,`,
    `not situation-specific reasoning); (b) it cost non-trivial exploration the model would`,
    `otherwise redo; (c) the surface is plausibly recurring. Otherwise NO-OP. Unsure -> don't.`,
    ``,
    `── Posture ──`,
    `Lenient about creating (bloat is the enemy), SLOW to promote (needs repetition), FAST to`,
    `demote (one proven hard-fact contradiction). Never harden on one run. Never store brittle`,
    `UI steps as fact. Never persist transient state. Never merge two surfaces. A user FACT`,
    `(accounts, prefs, contacts) goes in the PROFILE (${i.profile ? 'see current profile below' : 'currently empty'}), not a recipe.`,
    i.profile.trim() ? `\nCurrent profile:\n${i.profile}` : '',
    ``,
    `── Existing memory (name [confidence, surface]: description) ──`,
    index,
    ``,
    `── Your output ──`,
    writeRules,
    ``,
    `When finished, write your status file (${i.statusPath}) state=done with a one-line`,
    `result.summary of your decision (e.g. "no-op", "demoted gmail-inbox-sweep low",`,
    `"created canva-export low"). Follow the loaded Unmute contract for the status write.`,
  ].filter((l) => l !== '').join('\n')
}

// The serial queue holds two kinds of work: curating a finished task, and
// deterministic store maintenance (gardening). Both mutate the store, so they
// share ONE queue — the single-writer invariant covers gardening too.
type LibrarianJob =
  | { kind: 'curate'; s: RecipeSuggestion }
  | { kind: 'maint'; run: () => Promise<void>; done: () => void; fail: (e: unknown) => void }

export class Librarian {
  private queue: LibrarianJob[] = []
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
      writeEnabled: opts.writeEnabled ?? false,
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
    this.queue.push({ kind: 'curate', s })
    await this.drain()
  }

  /**
   * Run a deterministic store-maintenance pass (gardening) on the SAME serial
   * queue as librarian sessions, so a prune can never race a write-mode
   * librarian's create/move. Resolves when the pass has run (or rejects if it
   * throws). Fire-and-forget from callers.
   */
  runMaintenance(run: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ kind: 'maint', run, done: resolve, fail: reject })
      void this.drain()
    })
  }

  /** Process the queue one-at-a-time (serialized single writer, §9.2/§9.3). */
  private async drain(): Promise<void> {
    if (this.running) return // a drain loop is already active
    this.running = true
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!
        if (job.kind === 'curate') {
          try {
            await this.runOne(job.s)
          } catch (e) {
            log.error('librarian run failed (suggestion dropped)', { taskId: job.s.taskId, error: (e as Error).message })
          }
        } else {
          try {
            await job.run()
            job.done()
          } catch (e) {
            log.error('librarian maintenance failed', { error: (e as Error).message })
            job.fail(e)
          }
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
    const profilePath = userProfilePath(this.opts.baseDir || undefined)

    // Ensure the shared memory dirs exist (first run may pre-date them).
    await fs.mkdir(graduatedDir(this.opts.baseDir || undefined), { recursive: true })
    await fs.mkdir(recipesDir(this.opts.baseDir || undefined), { recursive: true })

    // The librarian gets its own working dir + status file under the task dir.
    const libCwd = join(s.cwd, 'librarian')
    const statusPath = join(libCwd, 'status.json')
    await scaffoldStatusFile(statusPath)
    await installContract(libCwd)

    // Resolve trace: prefer JSONL, fall back to PTY tail from suggestion.
    let reducedTrace = s.transcript ?? ''
    let traceSource: 'jsonl' | 'pty-fallback' = 'pty-fallback'
    try {
      const tFile = await locateTranscript(s.cwd)
      if (tFile) { reducedTrace = reduceTranscript(await fs.readFile(tFile, 'utf8')); traceSource = 'jsonl' }
    } catch (e) {
      // TEMP(memory-debug): remove after calibration
      llog.warn('trace resolve failed — using PTY fallback', { MEMORY_DEBUG: true, error: (e as Error).message })
    }
    const reducedTraceBytes = reducedTrace.length

    // Load existing memory for librarian context.
    let existing: Array<{ name: string; surface: string; confidence: string; description: string }> = []
    try {
      const recipes = await listRecipes({ baseDir: this.opts.baseDir || undefined })
      existing = recipes.map((r) => ({
        name: r.frontmatter.name,
        surface: r.frontmatter.surface,
        confidence: r.frontmatter.confidence,
        description: r.frontmatter.description,
      }))
    } catch (e) {
      // TEMP(memory-debug): remove after calibration
      llog.warn('listRecipes failed — continuing with empty memory', { MEMORY_DEBUG: true, error: (e as Error).message })
    }

    const profile = await readUserProfile(this.opts.baseDir || undefined)
    const proposalPath = join(libCwd, 'proposal.json')

    const intent = s.intent
    const outcome = s.outcome ?? 'done'
    const injectedRecipes = s.injectedRecipes ?? []
    const writeEnabled = this.opts.writeEnabled

    llog.event('librarian-start', {
      profilePath,
      existingRecipes: existing.length,
      hasProfile: !!profile.trim(),
      traceSource,
    })

    // Build and persist the full prompt for inspection.
    const prompt = buildLibrarianPrompt({
      intent,
      outcome,
      injectedRecipes,
      reducedTrace,
      existing,
      profile,
      writeEnabled,
      recipesDir: recipesDir(this.opts.baseDir || undefined),
      skillsDir: graduatedDir(this.opts.baseDir || undefined),
      proposalPath,
      statusPath,
    })

    try { await fs.writeFile(join(libCwd, 'librarian-prompt.txt'), prompt) }
    catch (e) { llog.warn('prompt-file write failed (continuing)', { MEMORY_DEBUG: true, error: (e as Error).message }) }

    // TEMP(memory-debug): remove after calibration
    llog.event('librarian-inputs', {
      MEMORY_DEBUG: true,
      intent,
      outcome,
      injectedRecipes,
      reducedTraceBytes,
      existingCount: existing.length,
      writeEnabled,
      traceSource,
    })

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

    ex.writeStdin(prompt)

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
}
