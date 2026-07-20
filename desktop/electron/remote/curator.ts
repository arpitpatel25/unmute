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
  setCandidateStatus,
  writeProposal,
  readRejections,
  readFeedback,
  markFeedbackConsumed,
  readTranscriptDelta,
  readProposal,
  readOwnership,
  ownedSkillNames,
  occurrenceKey,
  pruneTraces,
  type CuratorPaths,
  type DistillProcedure,
  type Candidate,
} from './curator-store'
import {
  buildDistillPrompt,
  parseDistillOutput,
  parseDistillReasoning,
  buildSynthesizePrompt,
  parseSynthesizeOutput,
  parseSynthesizeReasoning,
  buildMatchPrompt,
  parseMatchOutput,
  type MatchDecision,
} from './curator-prompts'
import { shortlist, applyMatch, recordSkillObservation, hasAccumulatedDivergence, isSuppressed } from './curator-match'
import { computeTriageMetrics, passesTriage } from './curator-triage'
import { devLogEnabled, devlog, devlogDump } from './curator-devlog'
import { unifiedDiff } from './curator-diff'
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
    // DEV-ONLY correlation id for this scheduler pass (no-op in prod).
    const checkId = `chk_${now}`

    // Gate 2 — due. Cursor is the authority on when we last swept.
    const cursor = await readCursor(this.paths)
    if (now - cursor.lastSweepAt < this.sweepIntervalMs()) {
      log.debug('checkNow refused: not due', { sinceLast: now - cursor.lastSweepAt, interval: this.sweepIntervalMs() })
      devlog({ stage: 'scheduler', kind: 'skip-not-due', checkId, sinceLast: now - cursor.lastSweepAt, interval: this.sweepIntervalMs() })
      return false
    }

    // Gate 3 — idle-preference. The interval will retry once things quiet down.
    if (this.isBusy()) {
      log.debug('checkNow deferred: app is busy (idle-preference)')
      devlog({ stage: 'scheduler', kind: 'skip-busy', checkId })
      return false
    }

    // Gate 4 — material scan. Only checkpoint-eligible, triage-passing deltas count.
    const material: MaterialSession[] = []
    const consumed: string[] = []       // taskIds admitted via an explicit checkpoint mark
    const sessions = await this.listSessions()
    for (const s of sessions) {
      const transcriptPath = await this.locateTranscriptFor(s)
      if (!transcriptPath) {
        devlog({ stage: 'scheduler', kind: 'session-skip', checkId, taskId: s.taskId, reason: 'no-transcript' })
        continue
      }

      const prior = cursor.sessions[s.taskId]
      const fromLine = prior?.lineOffset ?? 0
      const delta = await readTranscriptDelta(transcriptPath, fromLine)
      if (delta.lines.length === 0) {
        devlog({ stage: 'scheduler', kind: 'session-skip', checkId, taskId: s.taskId, reason: 'no-new-lines', fromLine })
        continue   // nothing new since last sweep
      }

      // Checkpoint requirement: an explicit checkpoint mark, OR the transcript
      // has been quiescent long enough to be sure the session isn't mid-flight.
      const checkpointed = this.pendingCheckpoints.has(s.taskId)
      const quiescent = checkpointed ? false : await this.isQuiescent(transcriptPath, now)
      if (!checkpointed && !quiescent) {
        log.debug('session skipped: no checkpoint and not yet quiescent', { taskId: s.taskId })
        devlog({ stage: 'scheduler', kind: 'session-skip', checkId, taskId: s.taskId, reason: 'not-checkpointed-not-quiescent', newLines: delta.lines.length })
        continue
      }

      // Triage — is this delta worth an LLM's attention?
      const metrics = computeTriageMetrics(delta.lines)
      const passed = passesTriage(metrics)
      if (!passed) {
        log.debug('session skipped: delta fails triage', { taskId: s.taskId, lines: delta.lines.length })
        devlog({ stage: 'scheduler', kind: 'session-skip', checkId, taskId: s.taskId, reason: 'fails-triage', checkpointed, metrics })
        continue
      }

      devlog({ stage: 'scheduler', kind: 'session-admit', checkId, taskId: s.taskId, intent: s.intent, checkpointed, fromLine, newLines: delta.lines.length, metrics })
      material.push({ taskId: s.taskId, intent: s.intent, transcriptPath, fromLine, lines: delta.lines, lookback: delta.lookback, newOffset: delta.newOffset })
      if (checkpointed) consumed.push(s.taskId)
    }

    // Gate 5 — no material, no LLM.
    if (material.length === 0) {
      log.debug('checkNow refused: no material this cycle')
      devlog({ stage: 'scheduler', kind: 'skip-no-material', checkId, sessionsScanned: sessions.length })
      return false
    }

    log.event('sweep-start', { sessions: material.length })
    devlog({ stage: 'scheduler', kind: 'sweep-start', checkId, sessions: material.map((m) => m.taskId) })
    await this.runSweep(material)
    // Cursor advancement belongs to the sweep (Task 9), not the scheduler —
    // a failed sweep (thrown above) leaves every delta re-readable next check.
    for (const id of consumed) this.pendingCheckpoints.delete(id)
    log.event('sweep-done', { sessions: material.length })
    devlog({ stage: 'scheduler', kind: 'sweep-done', checkId, sessions: material.length })
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
  curatedIndex: () => Promise<Array<{ name: string; description: string; body: string }>>  // init wires: owned names + on-disk descriptions + full SKILL.md bodies (for the D19 diff)
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
    // DEV-ONLY: thread the dev-log gate into the prompts so production pays no
    // extra tokens (the reasoning ask is absent when off). Reads the same single
    // gate the logger uses — one source of truth.
    const devMode = devLogEnabled()
    log2.event('sweep-pipeline-start', { sweepId, sessions: material.length })
    devlog({ stage: 'scheduler', kind: 'pipeline-start', sweepId, sessions: material.map((m) => m.taskId), devMode })

    try {
    // ── 1+2. Reduce + distill each session SEQUENTIALLY (parallelism would
    //         multiply peak subscription quota draw). Collect the procedures.
    // Existing skills WITH descriptions — the distiller compares observed work
    // against these to emit the agree/diverge modification signal (Constraint 7).
    // Derived from the SAME curatedIndex() the synth stage uses (called once,
    // reused below at step 4 as curatedFull).
    const curatedFull = await curatedIndex()
    const curatedSkills = curatedFull.map((s) => ({ name: s.name, description: s.description }))
    const distilled: Array<{ m: MaterialSession; procs: ReturnType<typeof parseDistillOutput>; tracePointer: string }> = []
    for (const m of material) {
      const reduced = reduceTranscript(m.lookback.concat(m.lines).join('\n'), { maxChars: 200_000 })
      const traceFile = join(paths.tracesDir, `${m.taskId}-${sweepId}.txt`)
      await fs.mkdir(paths.tracesDir, { recursive: true })
      await fs.writeFile(traceFile, reduced)

      const outPath = join(workRoot, `distill-${m.taskId}`, 'distill.json')
      const prompt = buildDistillPrompt({ taskId: m.taskId, intent: m.intent, tracePath: traceFile, outPath, curatedSkills, devMode })
      const raw = await runOneShot(`distill-${m.taskId}`, prompt, outPath, dirname(outPath))
      const procs = parseDistillOutput(raw)
      const reasoning = parseDistillReasoning(raw)   // DEV-ONLY: logged, never a decision input
      log2.event('distilled', { taskId: m.taskId, procedures: procs.length })
      // DEV-ONLY: the heavy inputs+output for this distill (trace pointer, full
      // prompt, raw model output) go to a per-stage dump; the structured decision
      // (methods found + reasoning) goes to the timeline.
      devlogDump(`${sweepId}-distill-${m.taskId}`, { sweepId, taskId: m.taskId, intent: m.intent, traceFile, reducedChars: reduced.length, prompt, rawOutput: raw })
      devlog({ stage: 'distill', kind: 'distilled', sweepId, taskId: m.taskId, intent: m.intent, traceFile, procedures: procs.map((p) => ({ title: p.title, count: p.count, struggle: p.struggle, usedCuratedSkill: p.usedCuratedSkill?.name })), reasoning })
      distilled.push({ m, procs, tracePointer: relative(paths.root, traceFile) })
    }

    // ── 3. Accumulate via a SINGLE semantic-matcher pass. Instead of a
    //       title-slug fold (which splits the same repeatable core across
    //       differently-worded sessions), ONE matcher session judges each
    //       distilled procedure against the ledger and fuses same-core findings.
    //   3a. Flatten every session's procedures into one ordered array. The flat
    //       index IS MatchDecision.procedureIndex — order is load-bearing.
    const at = nowIso()
    const flat: Array<{ proc: DistillProcedure; ctx: { taskId: string; sweepId: string; at: string; tracePointer: string; errors: number; recoveries: number; wallClockMs: number } }> = []
    for (const { m, procs, tracePointer } of distilled) {
      // Deterministic per-session struggle metrics — persisted onto every
      // occurrence this session contributes so a later proposal can backfill the
      // evidence strip even when the judge zeroed it (the "0 min of work" bug).
      const sm = computeTriageMetrics(m.lines)
      for (const proc of procs) flat.push({ proc, ctx: { taskId: m.taskId, sweepId, at, tracePointer, errors: sm.errors, recoveries: sm.recoveries, wallClockMs: sm.wallClockMs } })
    }

    //   3b. Combined shortlist off the CURRENT ledger — union of each proc's
    //       token-overlap shortlist, deduped by key, capped generously so the
    //       matcher prompt stays bounded.
    let candFile = await readCandidates(paths)
    // Score-aware union: each proc's shortlist pads up to its limit with
    // zero-overlap entries; unioning in insertion order let earlier procs'
    // padding crowd a later proc's genuine match past the 40-cap (a D2 fusion
    // miss). Drop zero-overlap (score 0) entries, dedup keeping the MAX score,
    // rank by shared-token score, THEN cap — a real match is never displaced by
    // another proc's padding.
    const shortlistByKey = new Map<string, { key: string; title: string; skeleton: string; score: number }>()
    for (const { proc } of flat) {
      for (const entry of shortlist(candFile, proc)) {
        if (entry.score <= 0) continue                        // zero-overlap padding — never worth a cap slot
        const prev = shortlistByKey.get(entry.key)
        if (!prev || entry.score > prev.score) shortlistByKey.set(entry.key, entry)
      }
    }
    const ledgerShortlist = Array.from(shortlistByKey.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map(({ key, title, skeleton }) => ({ key, title, skeleton }))

    //   3c. Exactly ONE matcher session per sweep (quota). It goes through the
    //       same runOneShot watch/RateLimitedError path as distill/synth, so a
    //       usage cap here still aborts the sweep with cursors untouched.
    let decisions: MatchDecision[] = []
    if (flat.length > 0) {
      const matchOut = join(workRoot, 'match', 'match.json')
      const matchPrompt = buildMatchPrompt({ procedures: flat.map((f) => f.proc), ledgerShortlist, outPath: matchOut, devMode })
      const matchRaw = await runOneShot('match', matchPrompt, matchOut, dirname(matchOut))
      decisions = parseMatchOutput(matchRaw)
      // DEV-ONLY: dump the matcher's full inputs+output; log the structured verdicts.
      devlogDump(`${sweepId}-match`, { sweepId, procedures: flat.map((f) => ({ title: f.proc.title, taskId: f.ctx.taskId })), ledgerShortlist, prompt: matchPrompt, rawOutput: matchRaw })
      devlog({ stage: 'accumulate', kind: 'matched', sweepId, procedures: flat.length, shortlist: ledgerShortlist.length, decisions: decisions.map((d) => ({ procedureIndex: d.procedureIndex, matchedKey: d.matchedKey, confidence: d.confidence, variedThisRun: d.variedThisRun })) })
    }

    //   3d. Fold each proc by its verdict. A missing/parse-empty/out-of-range
    //       decision degrades to {matchedKey:null} so a bad matcher NEVER loses
    //       data — every proc still becomes at least a watched entry.
    const decisionByIndex = new Map<number, MatchDecision>()
    for (const d of decisions) decisionByIndex.set(d.procedureIndex, d)
    for (let i = 0; i < flat.length; i++) {
      const { proc, ctx } = flat[i]
      const decision = decisionByIndex.get(i) ?? { procedureIndex: i, matchedKey: null, confidence: 0, variedThisRun: [] }
      const before = candFile.candidates
      candFile = applyMatch(candFile, proc, decision, ctx)
      const key = decision.matchedKey && before[decision.matchedKey] ? decision.matchedKey : occurrenceKey(proc.title)
      const cand = candFile.candidates[key]
      // DEV-ONLY: what this proc did to the ledger — matched vs new, bumped total,
      // whether the repetition (≥2) threshold got crossed.
      devlog({ stage: 'accumulate', kind: 'folded', sweepId, taskId: ctx.taskId, title: proc.title, key, matchedKey: decision.matchedKey, wasNew: !before[key], total: cand?.total, struggle: cand?.struggle, crossedRepetition: (cand?.total ?? 0) >= 2 })
    }

    //   3e. Record each proc's skillObservation (Constraint 7 MODIFICATION
    //       signal) onto the ledger entry that OWNS the named skill (linkedSkillId).
    //       Runs AFTER the applyMatch fold so newly-linked entries are already in
    //       candFile; a no-op when no entry links the skill. Folds into the SAME
    //       candFile persisted below — accumulation is the only reason a single
    //       run can't reshape a skill (hasAccumulatedDivergence gates that later).
    for (const { proc, ctx } of flat) {
      if (proc.skillObservation) {
        candFile = recordSkillObservation(candFile, proc.skillObservation, { sessionId: ctx.taskId, at: ctx.at })
        devlog({ stage: 'accumulate', kind: 'divergence-recorded', sweepId, taskId: ctx.taskId, skill: proc.skillObservation.skill, verdict: proc.skillObservation.verdict })
      }
    }
    // NB (I1): the merged ledger stays IN-MEMORY in `candFile` for the whole
    // sweep. We do NOT persist it here — a pre-synth write means a synth-stage
    // throw (the primary RateLimitedError backoff path) leaves candidates.json
    // mutated while the cursor stays put, so next sweep re-reads the same delta
    // AND regenerates sweepId → the (taskId, sweepId) idempotency key differs →
    // a SECOND occurrence is appended, permanently inflating total/struggle. The
    // single writeCandidates lives in the success-bookkeeping block below.

    // ── 4. Synthesize ONCE over the freshly-merged (in-memory) candidates + context.
    const candidates = Object.values(candFile.candidates)
    // curatedFull was fetched once at step 1 (reused here for synth + the D19 diff).
    const rejectionsRaw = await readRejections(paths)
    const rejections = rejectionsRaw.map((r) => ({ name: r.name, reason: r.reason }))
    const feedback = (await readFeedback(paths)).filter((f) => !f.consumedBySweep).map((f) => ({ skill: f.skill, note: f.note }))

    const synthOut = join(workRoot, 'synth', 'synth.json')
    const synthPrompt = buildSynthesizePrompt({ sweepId, candidates, curatedIndex: curatedFull, rejections, feedback, outPath: synthOut, devMode })
    devlog({ stage: 'synthesize', kind: 'synth-inputs', sweepId, candidateCount: candidates.length, librarySize: curatedFull.length, rejections: rejections.length, feedback: feedback.length })
    const synthRaw = await runOneShot('synth', synthPrompt, synthOut, dirname(synthOut))
    let proposals = parseSynthesizeOutput(synthRaw, sweepId, now)
    const synthReasoning = parseSynthesizeReasoning(synthRaw)   // DEV-ONLY: logged, never a decision input
    log2.event('synthesized', { sweepId, proposals: proposals.length })
    // DEV-ONLY: dump the full synth inputs + prompt + raw output; log the decision.
    devlogDump(`${sweepId}-synth`, { sweepId, candidates, curatedIndex: curatedFull.map((s) => ({ name: s.name, description: s.description })), rejections, feedback, prompt: synthPrompt, rawOutput: synthRaw })
    devlog({ stage: 'synthesize', kind: 'synthesized', sweepId, proposals: proposals.map((p) => ({ id: p.id, kind: p.kind, name: p.draft.name, targetSkill: p.targetSkill, rationale: p.rationale })), reasoning: synthReasoning })

    // ── 4a. DIVERGENCE GATE (Constraint 7). A `narrow` reshapes an existing
    //       skill toward its stable core — so it is only warranted when the
    //       ledger entry LINKED to that skill has ACCUMULATED divergence (≥2
    //       diverge observations). A single divergence is legitimate per-run
    //       variation, never a reshape; drop the narrow if the floor isn't met.
    //       create/split/merge/retire are NOT divergence-gated — leave them be.
    proposals = proposals.filter((prop) => {
      if (prop.kind !== 'narrow') return true
      const linked = candidates.find((c) => c.linkedSkillId === prop.targetSkill)
      if (!linked || !hasAccumulatedDivergence(linked)) {
        devlog({ stage: 'synthesize', kind: 'narrow-dropped-no-accumulated-divergence', sweepId, proposalId: prop.id, targetSkill: prop.targetSkill })
        return false
      }
      return true
    })

    // ── 4a-bis. CREATE-SUPPRESSION (Constraint 8 — "Reject → suppress (never
    //       re-surface)"). Once the user has rejected a name, that judgment is
    //       final and deterministic — no LLM re-litigation. Only `create`
    //       proposals are name-suppressible; narrow/split/merge/retire target
    //       an EXISTING owned skill (targetSkill), not a would-be new name, so
    //       they are not gated here.
    // M4: a create ACCEPTED downstream relies on its sourceKeys to link the new
    // skill back to its ledger entries (init.ts moves them to 'live' with
    // linkedSkillId) — that link is what later gardening (narrow/split/merge)
    // reads. LLM-dependent, so not enforced here.
    const ownedNames = ownedSkillNames(await readOwnership(paths))
    proposals = proposals.filter((prop) => {
      if (prop.kind !== 'create') return true
      if (isSuppressed(prop.draft.name, rejectionsRaw)) {
        devlog({ stage: 'synthesize', kind: 'create-dropped-suppressed', sweepId, proposalId: prop.id, name: prop.draft.name })
        return false
      }
      // A create for a name we ALREADY own would only dead-end at accept with a
      // 'collision'. Pre-filter it here (same drop as rejected-name suppression);
      // gardening kinds target an existing owned skill and are unaffected.
      if (ownedNames.has(prop.draft.name)) {
        devlog({ stage: 'synthesize', kind: 'create-dropped-owned-name', sweepId, proposalId: prop.id, name: prop.draft.name })
        return false
      }
      return true
    })

    // ── 4b. DETERMINISTIC diff (D19). The raw diff a user sees for a REWRITE
    //       (narrow/split/merge — each carries a full replacement body against an
    //       existing owned skill) is a pure function of the CURRENT on-disk body
    //       vs the proposed body — never LLM-authored, so it can never be
    //       plausible fiction. create (no previous version) and retire (no new
    //       body) carry no diff. curatedFull already holds every owned skill's body.
    const bodyByName = new Map(curatedFull.map((s) => [s.name, s.body]))
    const REWRITE_KINDS = new Set(['narrow', 'split', 'merge'])
    for (const prop of proposals) {
      if (REWRITE_KINDS.has(prop.kind) && prop.targetSkill) {
        const currentBody = bodyByName.get(prop.targetSkill)
        // Not found should not happen (a rewrite targets an owned skill); if it
        // does, leave diff undefined rather than diff against a phantom body.
        if (currentBody !== undefined) prop.diff = unifiedDiff(currentBody, prop.draft.body)
      }
    }

    // ── 4c. BACKFILL evidence from the sourceKeys candidates (the "0 min of
    //       work" fix). The judge often omits or zeros the evidence strip's
    //       numbers; those are DETERMINISTIC facts of the ledger, not judgment
    //       calls. For each field the judge left falsy/zero, fill it from the
    //       candidates the proposal was drawn from (their accumulated occurrences
    //       carry the per-session struggle metrics). A value the judge DID
    //       provide (non-zero) is left untouched. Proposals without sourceKeys —
    //       or whose keys aren't on the ledger — are left as-is.
    for (const prop of proposals) {
      if (!prop.sourceKeys || prop.sourceKeys.length === 0) continue
      const sources = prop.sourceKeys
        .map((k) => candFile.candidates[k])
        .filter((c): c is Candidate => c !== undefined)
      if (sources.length === 0) continue
      const ev = prop.evidence
      const sumOcc = (pick: (o: Candidate['occurrences'][number]) => number): number =>
        sources.reduce((s, c) => s + c.occurrences.reduce((a, o) => a + pick(o), 0), 0)
      if (!ev.occurrences) ev.occurrences = sources.reduce((s, c) => s + (c.total || 0), 0)
      if (!ev.struggle.errors) ev.struggle.errors = sumOcc((o) => o.errors ?? 0)
      if (!ev.struggle.recoveries) ev.struggle.recoveries = sumOcc((o) => o.recoveries ?? 0)
      if (!ev.struggle.wallClockMin) ev.struggle.wallClockMin = Math.round(sumOcc((o) => o.wallClockMs ?? 0) / 60000)
    }

    // ── 5. Persist each proposal: the JSON and its editable draft.md. A proposal
    //       is transient (D17) — it is NOT recorded in the ownership record;
    //       ownership is upserted only when a proposal is accepted and written.
    for (const prop of proposals) {
      await writeProposal(paths, prop)
      const draftPath = join(paths.proposalsDir, prop.id, 'draft.md')
      await fs.mkdir(dirname(draftPath), { recursive: true })
      await fs.writeFile(draftPath, prop.draft.body)
      devlog({ stage: 'writer', kind: 'proposal-written', sweepId, proposalId: prop.id, proposalKind: prop.kind, name: prop.draft.name, targetSkill: prop.targetSkill, hasDiff: prop.diff !== undefined })
    }

    // ── 5b. Lifecycle: every candidate a proposal drew from (its sourceKeys) is
    //       now SURFACED to the user for review. Folded into the SAME in-memory
    //       candFile (I1) so it lands in the single writeCandidates below,
    //       alongside the cursor advance. Proposals without sourceKeys are
    //       skipped. accept/reject later move these to live/rejected.
    const sourced = proposals.filter((prop) => prop.sourceKeys && prop.sourceKeys.length)
    for (const prop of sourced) {
      for (const key of prop.sourceKeys!) candFile = setCandidateStatus(candFile, key, 'surfaced')
    }

    // ── 6. Success bookkeeping — ONLY now. Any throw above (incl. a rate limit)
    //       skips this, leaving candidates.json / cursors / lastSweepAt untouched
    //       and every delta re-readable (re-fusing cleanly, no double-count).
    const tNow = now()
    // The SINGLE ledger write (I1): all mutations (applyMatch fold,
    // recordSkillObservation, surfaced-status) accumulated in `candFile`. A throw
    // before this point never touched candidates.json on disk.
    await writeCandidates(paths, candFile)
    const cursor = await readCursor(paths)
    for (const m of material) {
      const prev = cursor.sessions[m.taskId]
      cursor.sessions[m.taskId] = {
        transcriptPath: m.transcriptPath,
        lineOffset: m.newOffset,
        lastSweptAt: tNow,
        sweeps: (prev?.sweeps ?? 0) + 1,
      }
      devlog({ stage: 'scheduler', kind: 'cursor-advance', sweepId, taskId: m.taskId, lineOffset: m.newOffset, sweeps: (prev?.sweeps ?? 0) + 1 })
    }
    cursor.lastSweepAt = tNow
    await writeCursor(paths, cursor)
    await markFeedbackConsumed(paths, sweepId)
    // Retention (Global Constraint 12): prune raw traces past the rolling window.
    // Best-effort housekeeping — a prune failure must never break a done sweep.
    try { await pruneTraces(paths, tNow, 14) } catch { /* best-effort */ }
    log2.event('sweep-pipeline-done', { sweepId, proposals: proposals.length })
    devlog({ stage: 'scheduler', kind: 'pipeline-done', sweepId, proposals: proposals.length })
    } catch (err) {
      // DEV-ONLY: record the failure (rate-limit backoff or any throw) then
      // re-throw UNCHANGED — the sweep's cursor-on-success/backoff behavior is
      // untouched. A RateLimitedError still propagates so the scheduler backs off.
      devlog({ stage: 'scheduler', kind: err instanceof RateLimitedError ? 'rate-limited' : 'error', sweepId, error: (err as Error).message })
      throw err
    }
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
  /** Keystrokes that arrived before the PTY was alive (the popup starts the
   *  session lazily on the first NL edit, then writes in the same tick — see
   *  SkillReviewPopup.sendLine). Buffered here and flushed in order once start()
   *  has the PTY ready, so the FIRST edit instruction is never dropped. */
  private pending: string[] = []

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
      // PTY is now ready to accept raw keystrokes — flush anything the popup
      // wrote before we got here (preserving order), then reset the buffer.
      const queued = this.pending
      this.pending = []
      for (const chunk of queued) ex.write(chunk)
      log3.event('proposal-conversation-started', { proposalId: this.proposalId, cwd })
      return true
    } catch (e) {
      log3.warn('start failed', { proposalId: this.proposalId, error: (e as Error).message })
      try { ex.kill() } catch { /* best-effort */ }
      this.ex = null
      this.pending = []                          // spawn failed — drop buffered input, don't leak it
      return false
    }
  }

  /** Raw keystrokes from the popup terminal straight into the PTY (no CR added).
   *  Before the PTY is alive (lazy-start race), buffer so start() can flush. */
  write(data: string): void {
    if (this.ex?.alive) { this.ex.write(data); return }
    this.pending.push(data)
    if (this.pending.length > 64) this.pending.shift()   // safety valve — a review won't exceed this
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
