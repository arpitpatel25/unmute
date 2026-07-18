// Unmute Remote — the Skill Curator's SCHEDULER.
//
// This is the shell that decides WHEN a sweep runs; the sweep pipeline itself
// (distill → synthesize → propose → write) is Task 9 and is injected here as
// `runSweep` so the scheduling logic is testable in isolation.
//
// Four properties, all load-bearing:
//   1. Catch-up-on-wake — start() fires an immediate check, never a bare
//      interval-since-launch. A laptop that slept through the sweep window
//      still sweeps on wake, on the very next tick.
//   2. Material gate — a sweep only runs when at least one session transcript
//      has NEW, checkpoint-eligible, triage-passing lines. No material, no LLM.
//   3. Idle-preference — if the app is mid-utterance / mid-dispatch we defer;
//      the interval retries when things quiet down.
//   4. Single-flight — an in-progress check (including its awaited runSweep)
//      makes a concurrent checkNow return false immediately.
//
// CRITICAL: the scheduler does NOT write cursors. Cursor advancement belongs to
// the sweep (Task 9) so a triage-failing or sweep-failing delta stays fully
// re-readable on the next check.

import { promises as fs } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { createLogger } from './log'
import {
  curatorPaths,
  readCursor,
  writeCursor,
  readCandidates,
  writeCandidates,
  mergeDistill,
  writeProposal,
  readRejections,
  readFeedback,
  markFeedbackConsumed,
  readTranscriptDelta,
  readProposal,
  type CuratorPaths,
} from './curator-store'
import {
  buildDistillPrompt,
  parseDistillOutput,
  buildSynthesizePrompt,
  parseSynthesizeOutput,
} from './curator-prompts'
import { computeTriageMetrics, passesTriage } from './curator-triage'
import { locateTranscript, reduceTranscript } from './trace-reducer'
import type { ExecutorFactory, AgentExecutor } from './executor'

const log = createLogger('curator')

export interface SessionInfo { taskId: string; intent: string; cwd: string; kind: 'oneoff' | 'session' }

export interface CuratorOpts {
  paths?: CuratorPaths
  sweepIntervalMs: () => number                    // wire to getKnobs().curatorSweepIntervalMs
  listSessions: () => Promise<SessionInfo[]>       // Unmute session-kind tasks (init wires: scan ~/.unmute/remote/local/*/meta.json kind==='session')
  isBusy: () => boolean                            // idle-preference: utterance/dispatch in flight
  runSweep: (material: MaterialSession[]) => Promise<void>   // Task 9 provides the real one
  checkEveryMs?: number                            // default 10 * 60_000
  quiescentMs?: number                             // wake-scan checkpoint proxy: transcript mtime older than this. default 10 * 60_000
  now?: () => number
  // Test seam: resolve a session's transcript path. Defaults to locateTranscript(cwd).
  locateTranscriptFor?: (s: SessionInfo) => Promise<string | null>
}

export interface MaterialSession { taskId: string; intent: string; transcriptPath: string; fromLine: number; lines: string[]; lookback: string[]; newOffset: number }

export class Curator {
  private readonly paths: CuratorPaths
  private readonly sweepIntervalMs: () => number
  private readonly listSessions: () => Promise<SessionInfo[]>
  private readonly isBusy: () => boolean
  private readonly runSweep: (material: MaterialSession[]) => Promise<void>
  private readonly checkEveryMs: number
  private readonly quiescentMs: number
  private readonly now: () => number
  private readonly locateTranscriptFor: (s: SessionInfo) => Promise<string | null>

  /** Event-driven checkpoints: task ids whose owner declared a natural stopping
   *  point (task-manager 'done'/'ready'/kill). A checkpoint makes a session's
   *  delta eligible for a sweep even before the mtime-quiescence proxy fires. */
  private readonly pendingCheckpoints = new Set<string>()
  /** Single-flight guard: the in-progress check (including its awaited sweep). */
  private inFlight: Promise<boolean> | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(opts: CuratorOpts) {
    this.paths = opts.paths ?? curatorPaths()
    this.sweepIntervalMs = opts.sweepIntervalMs
    this.listSessions = opts.listSessions
    this.isBusy = opts.isBusy
    this.runSweep = opts.runSweep
    this.checkEveryMs = opts.checkEveryMs ?? 10 * 60_000
    this.quiescentMs = opts.quiescentMs ?? 10 * 60_000
    this.now = opts.now ?? (() => Date.now())
    this.locateTranscriptFor = opts.locateTranscriptFor ?? ((s) => locateTranscript(s.cwd))
  }

  /** Catch-up-on-wake: an immediate check, then a periodic (unref'd) retry. */
  start(): void {
    setImmediate(() => { this.checkNow().catch((err) => log.warn('checkNow failed', { error: (err as Error).message })) })
    this.timer = setInterval(() => { this.checkNow().catch((err) => log.warn('checkNow failed', { error: (err as Error).message })) }, this.checkEveryMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  /** Record a natural stopping point for a task (its delta becomes eligible). */
  notifyCheckpoint(taskId: string): void {
    this.pendingCheckpoints.add(taskId)
  }

  /** Due + material + not busy → a sweep ran. Returns whether runSweep fired.
   *  Single-flight: a concurrent call returns false immediately. */
  checkNow(): Promise<boolean> {
    if (this.inFlight) {
      log.debug('checkNow refused: a check is already in flight (single-flight)')
      return Promise.resolve(false)
    }
    const p = this.runCheck()
    this.inFlight = p
    return p.finally(() => { this.inFlight = null })
  }

  private async runCheck(): Promise<boolean> {
    const now = this.now()

    // Gate 2 — due. Cursor is the authority on when we last swept.
    const cursor = await readCursor(this.paths)
    if (now - cursor.lastSweepAt < this.sweepIntervalMs()) {
      log.debug('checkNow refused: not due', { sinceLast: now - cursor.lastSweepAt, interval: this.sweepIntervalMs() })
      return false
    }

    // Gate 3 — idle-preference. The interval will retry once things quiet down.
    if (this.isBusy()) {
      log.debug('checkNow deferred: app is busy (idle-preference)')
      return false
    }

    // Gate 4 — material scan. Only checkpoint-eligible, triage-passing deltas count.
    const material: MaterialSession[] = []
    const consumed: string[] = []       // taskIds admitted via an explicit checkpoint mark
    const sessions = await this.listSessions()
    for (const s of sessions) {
      const transcriptPath = await this.locateTranscriptFor(s)
      if (!transcriptPath) continue

      const prior = cursor.sessions[s.taskId]
      const fromLine = prior?.lineOffset ?? 0
      const delta = await readTranscriptDelta(transcriptPath, fromLine)
      if (delta.lines.length === 0) continue   // nothing new since last sweep

      // Checkpoint requirement: an explicit checkpoint mark, OR the transcript
      // has been quiescent long enough to be sure the session isn't mid-flight.
      const checkpointed = this.pendingCheckpoints.has(s.taskId)
      const quiescent = checkpointed ? false : await this.isQuiescent(transcriptPath, now)
      if (!checkpointed && !quiescent) {
        log.debug('session skipped: no checkpoint and not yet quiescent', { taskId: s.taskId })
        continue
      }

      // Triage — is this delta worth an LLM's attention?
      if (!passesTriage(computeTriageMetrics(delta.lines))) {
        log.debug('session skipped: delta fails triage', { taskId: s.taskId, lines: delta.lines.length })
        continue
      }

      material.push({ taskId: s.taskId, intent: s.intent, transcriptPath, fromLine, lines: delta.lines, lookback: delta.lookback, newOffset: delta.newOffset })
      if (checkpointed) consumed.push(s.taskId)
    }

    // Gate 5 — no material, no LLM.
    if (material.length === 0) {
      log.debug('checkNow refused: no material this cycle')
      return false
    }

    log.event('sweep-start', { sessions: material.length })
    await this.runSweep(material)
    // Cursor advancement belongs to the sweep (Task 9), not the scheduler —
    // a failed sweep (thrown above) leaves every delta re-readable next check.
    for (const id of consumed) this.pendingCheckpoints.delete(id)
    log.event('sweep-done', { sessions: material.length })
    return true
  }

  private async isQuiescent(transcriptPath: string, now: number): Promise<boolean> {
    try {
      const st = await fs.stat(transcriptPath)
      return now - st.mtimeMs >= this.quiescentMs
    } catch {
      return false
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Task 9 — the REAL sweep pipeline.
//
// makeRunSweep returns the runSweep the scheduler injects. Per cycle it drives
// one-shot Claude Code sessions (via the ExecutorFactory) to DISTILL each
// session's reduced trace into procedures, ACCUMULATES those into the candidate
// ledger, then a single SYNTHESIZE session turns the accumulated candidates into
// skill PROPOSALS. Everything is agent-agnostic through the executor seam.
//
// Two load-bearing properties:
//   • RATE-LIMIT BACKOFF — the moment a session's output shows a usage/rate cap,
//     we kill it and throw RateLimitedError out of the whole sweep. No partial
//     bookkeeping; the scheduler logs and the next check re-reads the same delta.
//   • CURSOR-ON-SUCCESS — cursors, lastSweepAt and feedback-consumption advance
//     ONLY after every distill, the merge, the synthesize, and all proposal
//     writes have succeeded. Any throw (incl. RateLimitedError) happens BEFORE
//     those writes, so a failed sweep leaves every delta fully re-readable.

const log2 = createLogger('curator-sweep')

/** Thrown when a one-shot session's output reveals a usage/rate-limit cap. It
 *  propagates out of runSweep so the scheduler can back off without advancing. */
export class RateLimitedError extends Error {
  constructor(message = 'Claude Code reported a usage/rate limit') {
    super(message)
    this.name = 'RateLimitedError'
  }
}

const RATE_LIMIT_RE = /usage limit|rate limit|limit reached|out of.*(credits|usage)/i
const OUT_CAP = 64_000                 // tail-cap on accumulated session output
const READY_GRACE_MS = 1_500           // settle the REPL past folder-trust before dispatch
const REINJECT_AT_MS = 15_000          // one re-inject if the prompt landed unsubmitted

export interface SweepDeps {
  executorFactory: ExecutorFactory
  paths: CuratorPaths
  curatedIndex: () => Promise<Array<{ name: string; description: string }>>  // init wires: owned names + on-disk descriptions
  sessionTimeoutMs?: number      // per one-shot, default 5 * 60_000
  submitConfirmMs?: number       // default 450 (the router/task-lane paste quirk)
  pollMs?: number                // default 250
  now?: () => number
}

/** A rate-limit sentinel: accumulates a session's output (tail-capped) and, the
 *  moment it matches the cap regex, rejects `signal` with RateLimitedError so any
 *  in-flight sleep/poll unwinds immediately. `signal` never resolves — only
 *  rejects — so racing it against a step aborts that step on a cap. */
function makeRateLimitWatch() {
  let buf = ''
  let tripped = false
  let error: RateLimitedError | null = null
  let doReject: ((e: RateLimitedError) => void) | null = null
  const signal = new Promise<never>((_, rej) => { doReject = rej })
  signal.catch(() => { /* keep un-awaited rejection from surfacing as unhandled */ })
  const onData = (chunk: string): void => {
    if (tripped) return
    buf += chunk
    if (buf.length > OUT_CAP) buf = buf.slice(-OUT_CAP)
    if (RATE_LIMIT_RE.test(buf)) {
      tripped = true
      error = new RateLimitedError()
      doReject?.(error)
    }
  }
  return {
    onData,
    signal,
    isTripped: (): boolean => tripped,
    error: (): RateLimitedError => error ?? new RateLimitedError(),
  }
}

export function makeRunSweep(deps: SweepDeps): (material: MaterialSession[]) => Promise<void> {
  const { executorFactory, paths, curatedIndex } = deps
  const sessionTimeoutMs = deps.sessionTimeoutMs ?? 5 * 60_000
  const submitConfirmMs = deps.submitConfirmMs ?? 450
  const pollMs = deps.pollMs ?? 250
  const now = deps.now ?? (() => Date.now())
  const nowIso = (): string => new Date(now()).toISOString()

  /** Sleep `ms`, but reject early (clearing the timer) if the watch trips. */
  const raceSleep = (ms: number, watch: ReturnType<typeof makeRateLimitWatch>): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms)
      watch.signal.then(undefined, (e) => { clearTimeout(t); reject(e) })
    })

  /** Drive one one-shot Claude Code session: spawn, settle past folder-trust,
   *  paste the prompt + confirm-submit, then poll the OUTPUT FILE until it
   *  appears or the timeout fires (with one re-inject at 15s). Throws
   *  RateLimitedError immediately on a usage/rate cap. Returns the file's raw
   *  contents, or null on timeout. Always kills the session (finally). */
  const runOneShot = async (label: string, prompt: string, outPath: string, workDir: string): Promise<string | null> => {
    await fs.mkdir(workDir, { recursive: true })
    await fs.rm(outPath, { force: true }).catch(() => {})
    const watch = makeRateLimitWatch()
    const ex: AgentExecutor = executorFactory()
    ex.onData(watch.onData)
    try {
      await ex.spawn({ cwd: workDir, env: process.env, taskId: `curator-${label}` })
      await ex.isReady()
      ex.writeStdin('')                                  // accept folder-trust prompt (fresh dir)
      await raceSleep(READY_GRACE_MS, watch)
      ex.writeStdin(prompt)
      await raceSleep(submitConfirmMs, watch)            // the TUI captures the multi-line prompt as a paste…
      if (ex.alive) ex.write('\r')                       // …that lands one Enter short — confirm-submit it

      const start = now()
      const deadline = start + sessionTimeoutMs
      let reinjected = false
      while (now() < deadline) {
        if (watch.isTripped()) throw watch.error()
        try {
          const raw = await fs.readFile(outPath, 'utf8')
          if (raw.trim()) return raw
        } catch { /* not written yet */ }
        const elapsed = now() - start
        // Self-heal: the paste occasionally sits unsubmitted. Clear the input
        // line (Ctrl-U, never Esc) and re-inject once.
        if (!reinjected && elapsed >= REINJECT_AT_MS && ex.alive) {
          reinjected = true
          log2.warn('one-shot slow — re-injecting prompt once', { label, elapsedMs: elapsed })
          ex.write('\x15')
          await raceSleep(200, watch)
          ex.writeStdin(prompt)
          await raceSleep(submitConfirmMs, watch)
          if (ex.alive) ex.write('\r')
        }
        await raceSleep(pollMs, watch)
      }
      log2.warn('one-shot timed out — no output file', { label, ms: sessionTimeoutMs, outPath })
      return null
    } finally {
      try { ex.kill() } catch { /* best-effort */ }
    }
  }

  return async function runSweep(material: MaterialSession[]): Promise<void> {
    const sweepId = `sw_${now()}`
    const workRoot = join(paths.root, 'work', sweepId)
    log2.event('sweep-pipeline-start', { sweepId, sessions: material.length })

    // ── 1+2. Reduce + distill each session SEQUENTIALLY (parallelism would
    //         multiply peak subscription quota draw). Collect the procedures.
    const curatedNames = (await curatedIndex()).map((s) => s.name)
    const distilled: Array<{ m: MaterialSession; procs: ReturnType<typeof parseDistillOutput>; tracePointer: string }> = []
    for (const m of material) {
      const reduced = reduceTranscript(m.lookback.concat(m.lines).join('\n'), { maxChars: 200_000 })
      const traceFile = join(paths.tracesDir, `${m.taskId}-${sweepId}.txt`)
      await fs.mkdir(paths.tracesDir, { recursive: true })
      await fs.writeFile(traceFile, reduced)

      const outPath = join(workRoot, `distill-${m.taskId}`, 'distill.json')
      const prompt = buildDistillPrompt({ taskId: m.taskId, intent: m.intent, tracePath: traceFile, outPath, curatedNames })
      const raw = await runOneShot(`distill-${m.taskId}`, prompt, outPath, dirname(outPath))
      const procs = parseDistillOutput(raw)
      log2.event('distilled', { taskId: m.taskId, procedures: procs.length })
      distilled.push({ m, procs, tracePointer: relative(paths.root, traceFile) })
    }

    // ── 3. Accumulate: fold every session's procedures into the candidate
    //       ledger (pure, idempotent per key,task,sweep), then persist once.
    let candFile = await readCandidates(paths)
    const at = nowIso()
    for (const { m, procs, tracePointer } of distilled) {
      candFile = mergeDistill(candFile, procs, { taskId: m.taskId, sweepId, at, tracePointer })
    }
    await writeCandidates(paths, candFile)

    // ── 4. Synthesize ONCE over the freshly-merged candidates + context.
    const merged = await readCandidates(paths)
    const candidates = Object.values(merged.candidates)
    const curatedFull = await curatedIndex()
    const rejections = (await readRejections(paths)).map((r) => ({ name: r.name, reason: r.reason }))
    const feedback = (await readFeedback(paths)).filter((f) => !f.consumedBySweep).map((f) => ({ skill: f.skill, note: f.note }))

    const synthOut = join(workRoot, 'synth', 'synth.json')
    const synthPrompt = buildSynthesizePrompt({ sweepId, candidates, curatedIndex: curatedFull, rejections, feedback, outPath: synthOut })
    const synthRaw = await runOneShot('synth', synthPrompt, synthOut, dirname(synthOut))
    const proposals = parseSynthesizeOutput(synthRaw, sweepId, now)
    log2.event('synthesized', { sweepId, proposals: proposals.length })

    // ── 5. Persist each proposal: the JSON and its editable draft.md. A proposal
    //       is transient (D17) — it is NOT recorded in the ownership record;
    //       ownership is upserted only when a proposal is accepted and written.
    for (const prop of proposals) {
      await writeProposal(paths, prop)
      const draftPath = join(paths.proposalsDir, prop.id, 'draft.md')
      await fs.mkdir(dirname(draftPath), { recursive: true })
      await fs.writeFile(draftPath, prop.draft.body)
    }

    // ── 6. Success bookkeeping — ONLY now. Any throw above (incl. a rate limit)
    //       skips this, leaving cursors/lastSweepAt untouched and re-readable.
    const tNow = now()
    const cursor = await readCursor(paths)
    for (const m of material) {
      const prev = cursor.sessions[m.taskId]
      cursor.sessions[m.taskId] = {
        transcriptPath: m.transcriptPath,
        lineOffset: m.newOffset,
        lastSweptAt: tNow,
        sweeps: (prev?.sweeps ?? 0) + 1,
      }
    }
    cursor.lastSweepAt = tNow
    await writeCursor(paths, cursor)
    await markFeedbackConsumed(paths, sweepId)
    log2.event('sweep-pipeline-done', { sweepId, proposals: proposals.length })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Task 10 — the review popup's CONVERSATION backend.
//
// One live Claude Code session per proposal under review, spawned INSIDE the
// proposal's own dir (proposals/<id>/) so it can only see that proposal's two
// files: proposal.json (read-only context + evidence pointers) and draft.md
// (the editable draft the session EDITS in place when the user asks). Raw PTY
// output streams straight to the popup terminal via onData; raw keystrokes flow
// back through write() (no carriage return added — the xterm sends exact bytes).
//
// The Curator holds a Map<proposalId, ProposalConversation> (Task 12) so a
// second start for the same id stops the first; THIS class is one conversation.

const log3 = createLogger('proposal-conversation')

/** Grace after accepting the folder-trust prompt, before the primer is typed —
 *  the REPL needs a moment to settle past the trust dialog into its input box. */
const PROPOSAL_READY_GRACE_MS = 1_500

export interface ProposalConversationOpts {
  executorFactory: ExecutorFactory
  paths: CuratorPaths
  proposalId: string
  onData: (chunk: string) => void
  /** Test seam / tunable: ms to wait after the trust-clear before typing the
   *  primer. Defaults to PROPOSAL_READY_GRACE_MS. */
  readyGraceMs?: number
}

export class ProposalConversation {
  private readonly executorFactory: ExecutorFactory
  private readonly paths: CuratorPaths
  private readonly proposalId: string
  private readonly onData: (chunk: string) => void
  private readonly readyGraceMs: number
  private ex: AgentExecutor | null = null

  constructor(opts: ProposalConversationOpts) {
    this.executorFactory = opts.executorFactory
    this.paths = opts.paths
    this.proposalId = opts.proposalId
    this.onData = opts.onData
    this.readyGraceMs = opts.readyGraceMs ?? PROPOSAL_READY_GRACE_MS
  }

  /** True while the session's PTY is alive. */
  get alive(): boolean {
    return this.ex?.alive === true
  }

  /** Spawn a CC session in proposals/<id>/, primed to discuss THIS proposal and
   *  edit its draft.md in place. Streams raw output via onData. Returns false if
   *  the proposal is missing or the session fails to start. */
  async start(): Promise<boolean> {
    const prop = await readProposal(this.paths, this.proposalId)
    if (!prop) {
      log3.warn('start refused: proposal not found', { proposalId: this.proposalId })
      return false
    }
    const cwd = join(this.paths.proposalsDir, this.proposalId)
    const ex = this.executorFactory()
    this.ex = ex
    ex.onData((chunk) => this.onData(chunk))     // popup renders raw PTY output verbatim
    try {
      await ex.spawn({ cwd, env: process.env, taskId: `curator-review-${this.proposalId}` })
      await ex.isReady()
      ex.writeStdin('')                          // accept folder-trust prompt (fresh dir)
      await new Promise((r) => setTimeout(r, this.readyGraceMs))
      ex.writeStdin(this.primer())               // ONE priming turn — points the session at the files
      log3.event('proposal-conversation-started', { proposalId: this.proposalId, cwd })
      return true
    } catch (e) {
      log3.warn('start failed', { proposalId: this.proposalId, error: (e as Error).message })
      try { ex.kill() } catch { /* best-effort */ }
      this.ex = null
      return false
    }
  }

  /** Raw keystrokes from the popup terminal straight into the PTY (no CR added). */
  write(data: string): void {
    if (this.ex?.alive) this.ex.write(data)
  }

  /** Kill the session (the popup closed / a fresh conversation supersedes it). */
  stop(): void {
    if (!this.ex) return
    try { this.ex.kill() } catch { /* best-effort */ }
    this.ex = null
  }

  private primer(): string {
    return [
      '[Unmute curator — proposal review] You are discussing ONE proposed skill with the user.',
      `The proposal: ./proposal.json (evidence pointers inside reference reduced traces under ${this.paths.tracesDir}).`,
      'The editable draft: ./draft.md — when the user asks for changes, EDIT that file in place and confirm what changed.',
      "Answer questions about why this skill was proposed (read proposal.json's evidence + rationale).",
      'Never touch any file outside this directory. Start by summarizing the proposal in two sentences.',
    ].join('\n')
  }
}
