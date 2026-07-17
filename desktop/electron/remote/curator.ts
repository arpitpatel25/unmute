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
import { createLogger } from './log'
import {
  curatorPaths,
  readCursor,
  readTranscriptDelta,
  type CuratorPaths,
} from './curator-store'
import { computeTriageMetrics, passesTriage } from './curator-triage'
import { locateTranscript } from './trace-reducer'

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
    setImmediate(() => { void this.checkNow() })
    this.timer = setInterval(() => { void this.checkNow() }, this.checkEveryMs)
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
