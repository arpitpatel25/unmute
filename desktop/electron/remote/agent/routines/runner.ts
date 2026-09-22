import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { diagnostic, diagnosticError } from '../../diagnostics'
import type { RoutineDefinition } from './definition'
import type { RoutineExecutor, RoutineExecutorHandle, ExecuteOutcome } from './executor'
import { buildManifest, writeManifest } from './manifest'
import { routineTranscript } from './prompt'
import { liftProposals } from './proposals'
import type { RoutineRunLog } from './run-log'
import { nextFireAt } from './schedule'
import type { RoutineStore } from './store'
import type { RoutineProposal, RoutineRun, RunTrigger } from './types'
import { writeFileAtomic } from './atomic'
import { computeWindow } from './window'

export interface RunnerDeps {
  store: RoutineStore; log: RoutineRunLog; executor: RoutineExecutor
  runsDir: string; indexDir: string; excludeCwdPart: string
  agentProvider(): 'claude' | 'codex'; now?: () => number; randomId?: () => string
  setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void
  maxConcurrent?: number; lateGraceMs?: number; tickMs?: number
  onChange(): void
}

export type MeetingNotesEvent = { type: 'meeting-notes-ready'; meetingId: string; title?: string; notesPath?: string }

const MAX_ACTIVITY = 30
const PREVIEW_CHARS = 600
const ACTIVITY_PERSIST_MS = 1000

interface ActiveRun {
  run: RoutineRun
  handle?: RoutineExecutorHandle
  /** Why the executor was told to stop. `timeout` settles failed, `user` cancelled; `shutdown`
   *  runs are settled by dispose() itself and their later completion is ignored. */
  stopReason?: 'user' | 'timeout' | 'shutdown'
  budgetTimer?: unknown
  activityTimer?: unknown
  lastActivityPersistAt: number
}

const INTERRUPTED: Partial<RoutineRun> = {
  status: 'failed', reason: 'interrupted', resultPreview: 'Interrupted when Unmute restarted.', posted: true, unread: true,
}
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'skipped'])
const clone = (run: RoutineRun): RoutineRun => ({
  ...run, activity: [...run.activity], ...(run.proposals ? { proposals: run.proposals.map(p => ({ ...p })) } : {}),
})
const hhmm = (at: number) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

/** §4 "RoutineRunner": clock/interval ticks, events, idempotency keys, a pool of
 *  `maxConcurrent`, per-run budgets, cancel, proposals and restart recovery. */
export class RoutineRunner {
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (h: unknown) => void
  private readonly maxConcurrent: number
  private readonly lateGraceMs: number
  private readonly tickMs: number
  private readonly active = new Map<string, ActiveRun>()
  private readonly queue: RoutineRun[] = []
  private ticking: Promise<void> = Promise.resolve()
  private tickTimer: unknown = null
  private disposed = false
  /** `${runId}:${proposalId}` decisions whose write has not landed yet; the log still reads `open`. */
  private readonly deciding = new Set<string>()

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? Date.now
    this.randomId = deps.randomId ?? randomUUID
    this.setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
    this.clearTimer = deps.clearTimer ?? (h => clearTimeout(h as NodeJS.Timeout))
    this.maxConcurrent = deps.maxConcurrent ?? 2
    this.lateGraceMs = deps.lateGraceMs ?? 6 * 3_600_000
    this.tickMs = deps.tickMs ?? 30_000
  }

  async start(): Promise<void> {
    for (const stale of this.deps.log.all().filter(r => r.status === 'running' || r.status === 'queued')) {
      const run = clone(stale)
      Object.assign(run, INTERRUPTED, { endedAt: this.now() })
      await this.save(run)
      await this.settleParentProposal(run)
    }
    await this.tick()
    this.scheduleTick()
  }

  tick(): Promise<void> {
    const next = this.ticking.then(() => this.checkDue())
    this.ticking = next.catch(() => {})
    return next
  }

  wake(): Promise<void> { return this.tick() }

  async runNow(id: string): Promise<RoutineRun> {
    const entry = this.deps.store.get(id)
    if (!entry) throw new Error(`Routine "${id}" was not found`)
    if (!entry.definition) throw new Error(entry.error ?? `Routine "${id}" is not valid`)
    const runId = this.randomId()
    return this.enqueue(entry.definition, { type: 'manual' }, `${id}@manual:${runId}`, runId)
  }

  async event(e: MeetingNotesEvent): Promise<RoutineRun[]> {
    const runs: RoutineRun[] = []
    for (const entry of this.deps.store.list()) {
      const d = entry.definition
      if (!d || !entry.state.enabled || d.schedule.type !== 'event') continue
      if (d.context?.meetingIds?.length && !d.context.meetingIds.includes(e.meetingId)) continue
      const key = `${d.id}@event:${e.meetingId}`
      if (this.hasKey(key)) continue
      const trigger: RunTrigger = {
        type: 'event', event: e.type, meetingId: e.meetingId,
        ...(e.title !== undefined ? { title: e.title } : {}), ...(e.notesPath !== undefined ? { notesPath: e.notesPath } : {}),
      }
      runs.push(await this.enqueue(d, trigger, key))
    }
    return runs
  }

  async cancel(runId: string): Promise<boolean> {
    const queuedIndex = this.queue.findIndex(r => r.id === runId)
    if (queuedIndex >= 0) {
      const [run] = this.queue.splice(queuedIndex, 1)
      await this.settle(run!, { status: 'cancelled', posted: false, unread: false })
      return true
    }
    const active = this.active.get(runId)
    if (!active) return false
    active.stopReason = 'user'
    await active.handle?.cancel()
    return true
  }

  async decideProposal(runId: string, proposalId: string, decision: 'approve' | 'dismiss'): Promise<RoutineRun | null> {
    const stored = this.deps.log.get(runId)
    const proposal = stored?.proposals?.find(p => p.id === proposalId)
    if (!stored || !proposal) return null
    const decisionKey = `${runId}:${proposalId}`
    if (proposal.state !== 'open' || this.deciding.has(decisionKey)) return stored
    this.deciding.add(decisionKey)
    try {
      return await this.decide(stored, proposalId, decision)
    } finally {
      this.deciding.delete(decisionKey)
    }
  }

  private async decide(stored: RoutineRun, proposalId: string, decision: 'approve' | 'dismiss'): Promise<RoutineRun> {
    const parent = clone(stored)
    const target = parent.proposals!.find(p => p.id === proposalId)!
    if (decision === 'dismiss') {
      target.state = 'dismissed'
      await this.save(parent)
      return parent
    }
    const definition = this.deps.store.get(parent.routineId)?.definition
    if (!definition) throw new Error(`Routine "${parent.routineId}" is not available`)
    const childId = this.randomId()
    target.state = 'running'
    target.runId = childId
    await this.save(parent)
    await this.enqueue(definition, { type: 'approval', parentRunId: parent.id, proposalId }, `${definition.id}@approval:${childId}`, childId)
    return this.deps.log.get(parent.id) ?? parent
  }

  async markRead(): Promise<void> {
    const unread = this.deps.log.all().filter(r => r.unread)
    for (const run of unread) await this.deps.log.upsert({ ...clone(run), unread: false })
    this.deps.onChange()
  }

  /** §4 Restart: a run cut off by shutdown surfaces as failed/interrupted, the same as one found
   *  on the next start. It is settled (and awaited) here, before the handles are cancelled, so the
   *  cancel's own completion can never land first and record it as a user cancel. */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.tickTimer !== null) { this.clearTimer(this.tickTimer); this.tickTimer = null }
    const actives = [...this.active.values()]
    const queued = this.queue.splice(0)
    for (const active of actives) active.stopReason = 'shutdown'
    for (const run of [...actives.map(a => a.run), ...queued]) await this.settle(run, INTERRUPTED)
    await Promise.all(actives.map(a => a.handle?.cancel().catch(error => diagnostic('routines-cancel-failed', diagnosticError(error)))))
  }

  private scheduleTick(): void {
    if (this.disposed) return
    this.tickTimer = this.setTimer(() => {
      this.tickTimer = null
      void this.tick()
        .catch(error => diagnostic('routines-tick-failed', diagnosticError(error)))
        .finally(() => this.scheduleTick())
    }, this.tickMs)
  }

  private hasKey(key: string): boolean {
    return this.deps.log.hasKey(key) || this.queue.some(r => r.key === key) || [...this.active.values()].some(a => a.run.key === key)
  }

  private async checkDue(): Promise<void> {
    if (this.disposed) return
    for (const entry of this.deps.store.list()) {
      const d = entry.definition
      const fireAt = entry.state.nextFireAt
      if (!d || d.schedule.type === 'event' || fireAt === null) continue
      const now = this.now()
      if (fireAt > now) continue
      // One routine that fails to fire (a write error, removed mid-tick) must not stop the others.
      try {
        if (entry.state.enabled) {
          const key = `${d.id}@${new Date(fireAt).toISOString().slice(0, 16)}`
          if (!this.hasKey(key)) {
            if (now - fireAt > this.lateGraceMs) await this.recordMissed(d, fireAt, key)
            else await this.enqueue(d, { type: 'schedule', scheduledFor: fireAt }, key)
          }
        }
        await this.deps.store.setNextFireAt(d.id, nextFireAt(d.schedule, now))
      } catch (error) {
        diagnostic('routines-fire-failed', { routineId: d.id, ...diagnosticError(error) })
      }
    }
  }

  private async recordMissed(d: RoutineDefinition, fireAt: number, key: string): Promise<void> {
    const now = this.now()
    await this.save({
      ...this.baseRun(d, { type: 'schedule', scheduledFor: fireAt }, key, this.randomId()),
      status: 'skipped', reason: 'missed', endedAt: now,
      resultPreview: `Skipped: Unmute wasn't running at ${hhmm(fireAt)}.`, posted: true, unread: true,
    })
  }

  private baseRun(d: RoutineDefinition, trigger: RunTrigger, key: string, id: string): RoutineRun {
    return {
      id, routineId: d.id, name: d.name, key, kind: d.kind, trigger, status: 'queued', firedAt: this.now(),
      activity: [], posted: false, unread: false, speak: d.speak,
      color: this.deps.store.get(d.id)?.state.color ?? 'white',
    }
  }

  private async enqueue(d: RoutineDefinition, trigger: RunTrigger, key: string, id = this.randomId()): Promise<RoutineRun> {
    const run = this.baseRun(d, trigger, key, id)
    if (trigger.type !== 'approval') {
      const window = computeWindow(d.window, run.firedAt, this.deps.log.lastSuccess(d.id)?.firedAt ?? null)
      if (window) run.window = window
    }
    this.queue.push(run)
    await this.save(run)
    await this.pump()
    return clone(this.active.get(run.id)?.run ?? this.deps.log.get(run.id) ?? run)
  }

  private async pump(): Promise<void> {
    while (!this.disposed && this.active.size < this.maxConcurrent && this.queue.length > 0) {
      await this.startRun(this.queue.shift()!)
    }
  }

  private async startRun(run: RoutineRun): Promise<void> {
    const active: ActiveRun = { run, lastActivityPersistAt: 0 }
    this.active.set(run.id, active)
    try {
      const entry = this.deps.store.get(run.routineId)
      const d = entry?.definition
      if (!d) {
        await this.settle(run, { status: 'failed', reason: 'invalid', error: entry?.error ?? `Routine "${run.routineId}" was not found` })
        return
      }
      const runDir = join(this.deps.runsDir, run.id)
      let manifestPath: string | undefined
      if (run.trigger.type !== 'approval' && d.inputs.includes('sessions') && (run.window || d.context)) {
        const manifestWindow = run.window ?? { start: 0, end: run.firedAt, label: 'All indexed history' }
        const manifest = await buildManifest({ indexDir: this.deps.indexDir, window: manifestWindow, excludeCwdPart: this.deps.excludeCwdPart, context: d.context })
        manifestPath = (await writeManifest(runDir, manifest)).mdPath
        if (this.active.get(run.id) !== active) return
        run.manifestTotals = manifest.totals
        if (d.inputs.length === 1 && !d.context?.files.length && manifest.totals.turns === 0) {
          const note = d.whenEmpty === 'note'
          await this.settle(run, {
            status: 'skipped', reason: 'nothing-in-window', posted: note, unread: note,
            ...(note ? { resultPreview: d.context ? `No matching session activity in ${manifestWindow.label}.` : `Nothing since ${manifestWindow.label.split(' → ')[0]}.` } : {}),
          })
          return
        }
      }
      const transcript = routineTranscript({
        definition: d, trigger: this.transcriptTrigger(run.trigger), window: run.window ?? null, resultsDir: this.deps.runsDir,
        ...(manifestPath ? { manifestPath, manifestTotals: run.manifestTotals } : {}),
        ...(run.trigger.type === 'approval' ? { approval: await this.approvalContext(run.trigger) } : {}),
      })
      if (this.active.get(run.id) !== active) return
      if (active.stopReason) { await this.settle(run, { status: 'cancelled', posted: false, unread: false }); return }
      const provider = d.kind === 'takes-actions' ? 'claude' : d.provider === 'agent' ? this.deps.agentProvider() : d.provider
      Object.assign(run, { status: 'running', startedAt: this.now(), provider })
      const handle = this.deps.executor.start({
        run: clone(run), definition: d, transcript, runDir, provider, onActivity: text => this.activity(active, text),
      })
      active.handle = handle
      run.agentRunId = handle.agentRunId
      handle.completion
        .then(outcome => this.complete(active, d, runDir, outcome))
        .catch(async error => {
          diagnostic('routines-complete-failed', { runId: run.id, ...diagnosticError(error) })
          if (this.active.get(run.id) === active) await this.settle(run, this.failure('provider', errorMessage(error)))
        })
      await this.save(run)
      if (this.active.get(run.id) !== active) return
      active.budgetTimer = this.setTimer(() => {
        if (active.stopReason) return
        active.stopReason = 'timeout'
        void handle.cancel().catch(error => diagnostic('routines-cancel-failed', diagnosticError(error)))
      }, d.maxMinutes * 60_000)
    } catch (error) {
      diagnostic('routines-start-failed', { runId: run.id, ...diagnosticError(error) })
      if (this.active.get(run.id) === active) await this.settle(run, this.failure('provider', errorMessage(error)))
    }
  }

  private transcriptTrigger(trigger: RunTrigger): RunTrigger {
    if (trigger.type !== 'event') return trigger
    return { ...trigger, title: trigger.title ?? 'Untitled meeting', notesPath: trigger.notesPath ?? '(not available)' }
  }

  private async approvalContext(trigger: Extract<RunTrigger, { type: 'approval' }>): Promise<{ proposal: RoutineProposal; parentResult: string }> {
    const parent = this.deps.log.get(trigger.parentRunId)
    const proposal = parent?.proposals?.find(p => p.id === trigger.proposalId)
    if (!parent || !proposal) throw new Error('The approved proposal is no longer available')
    let parentResult = parent.resultPreview ?? ''
    if (parent.resultPath) parentResult = await fs.readFile(parent.resultPath, 'utf8').catch(() => parentResult)
    return { proposal, parentResult }
  }

  private failure(reason: 'provider' | 'timeout', error: string): Partial<RoutineRun> {
    return { status: 'failed', reason, error, resultPreview: `Couldn't finish: ${error}`, posted: true, unread: true }
  }

  private async complete(active: ActiveRun, d: RoutineDefinition, runDir: string, outcome: ExecuteOutcome): Promise<void> {
    const run = active.run
    // Settled elsewhere already (shutdown): the executor's late answer changes nothing.
    if (this.active.get(run.id) !== active) return
    if (outcome.providerSessionId) run.providerSessionId = outcome.providerSessionId
    if (outcome.outcome === 'completed') {
      const lifted = liftProposals(outcome.text ?? '', this.randomId)
      let resultPath: string | undefined = join(runDir, 'result.md')
      try {
        await fs.mkdir(runDir, { recursive: true })
        await writeFileAtomic(resultPath, lifted.text)
      } catch (error) {
        // A disk error never turns a finished run into a failure; the preview still carries the result.
        diagnostic('routines-result-write-failed', { runId: run.id, ...diagnosticError(error) })
        resultPath = undefined
      }
      if (this.active.get(run.id) !== active) return
      await this.settle(run, {
        status: 'done', ...(resultPath ? { resultPath } : {}), resultPreview: lifted.text.slice(0, PREVIEW_CHARS), posted: true, unread: true,
        ...(lifted.proposals.length ? { proposals: lifted.proposals } : {}),
      })
    } else if (outcome.outcome === 'failed') {
      await this.settle(run, this.failure('provider', outcome.error ?? 'The routine did not complete.'))
    } else if (active.stopReason === 'timeout') {
      await this.settle(run, this.failure('timeout', `Ran out of time after ${d.maxMinutes} min`))
    } else {
      await this.settle(run, { status: 'cancelled', posted: false, unread: false })
    }
  }

  private activity(active: ActiveRun, text: string): void {
    if (this.active.get(active.run.id) !== active) return
    const run = active.run
    run.activity.push({ at: this.now(), text })
    if (run.activity.length > MAX_ACTIVITY) run.activity.splice(0, run.activity.length - MAX_ACTIVITY)
    if (active.activityTimer !== undefined) return
    const elapsed = this.now() - active.lastActivityPersistAt
    const persist = () => {
      active.activityTimer = undefined
      if (this.active.get(run.id) !== active) return
      active.lastActivityPersistAt = this.now()
      void this.save(run).catch(error => diagnostic('routines-activity-save-failed', { runId: run.id, ...diagnosticError(error) }))
    }
    if (elapsed >= ACTIVITY_PERSIST_MS) persist()
    else active.activityTimer = this.setTimer(persist, ACTIVITY_PERSIST_MS - elapsed)
  }

  private clearRunTimers(active: ActiveRun): void {
    if (active.budgetTimer !== undefined) { this.clearTimer(active.budgetTimer); active.budgetTimer = undefined }
    if (active.activityTimer !== undefined) { this.clearTimer(active.activityTimer); active.activityTimer = undefined }
  }

  private async settle(run: RoutineRun, patch: Partial<RoutineRun>): Promise<void> {
    const active = this.active.get(run.id)
    if (active) { this.clearRunTimers(active); this.active.delete(run.id) }
    Object.assign(run, patch, { endedAt: this.now() })
    // Settling never throws: a failed write is retried once and then logged, so an outcome is
    // never replaced by a second, disk-caused one.
    try {
      await this.save(run)
    } catch (error) {
      diagnostic('routines-settle-save-failed', { runId: run.id, retry: true, ...diagnosticError(error) })
      await this.save(run).catch(retryError => diagnostic('routines-settle-save-failed', { runId: run.id, ...diagnosticError(retryError) }))
    }
    await this.settleParentProposal(run).catch(error => diagnostic('routines-proposal-save-failed', { runId: run.id, ...diagnosticError(error) }))
    await this.pump()
  }

  private async settleParentProposal(child: RoutineRun): Promise<void> {
    if (child.trigger.type !== 'approval' || !TERMINAL.has(child.status)) return
    const { parentRunId, proposalId } = child.trigger
    const stored = this.deps.log.get(parentRunId)
    if (!stored?.proposals?.some(p => p.id === proposalId)) return
    const parent = clone(stored)
    const proposal = parent.proposals!.find(p => p.id === proposalId)!
    // A user cancel makes the proposal approvable again. A failure, timeout or shutdown may have
    // partly done the action, so it must not be one tap away from repeating.
    if (child.status === 'cancelled') {
      if (proposal.runId !== child.id) return
      proposal.state = 'open'
      delete proposal.runId
    } else {
      proposal.state = child.status === 'done' ? 'done' : 'failed'
      proposal.runId = child.id
    }
    await this.save(parent)
  }

  /** §4 "every state change": persist first, then tell the view. */
  private async save(run: RoutineRun): Promise<void> {
    await this.deps.log.upsert(clone(run))
    this.deps.onChange()
  }
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
