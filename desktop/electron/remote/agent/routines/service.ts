import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import type { RoutineFields } from './definition'
import type { RoutineExecutor } from './executor'
import { defaultIndexDir } from './manifest'
import { RoutineRunLog } from './run-log'
import { RoutineRunner, type MeetingNotesEvent } from './runner'
import { describeNext, describeSchedule } from './schedule'
import { RoutineStore } from './store'
import { formatWindow } from './window'
import type { RoutineEntry, RoutineItemView, RoutineRun, RoutinesView, RunStatus } from './types'

const OFF_REASON = 'Routines are turned off in Settings'
const VIEW_RUNS = 60
const TERMINAL: ReadonlySet<RunStatus> = new Set(['done', 'failed', 'cancelled', 'skipped'])

export interface RoutineServiceOptions {
  root: string
  executor: RoutineExecutor
  agentProvider(): 'claude' | 'codex'
  emit(view: RoutinesView): void
  enabled: boolean
  now?: () => number
  indexDir?: string
  /** fs.watch the routines directory for hand edits (default true). */
  watch?: boolean
}

/** §4 facade for RPC, the Agent capability and view events. `root` is the Agent root R. */
export class RoutineService {
  private readonly now: () => number
  private readonly routinesDir: string
  private readonly runsDir: string
  private readonly store: RoutineStore
  private readonly log: RoutineRunLog
  private readonly runner: RoutineRunner
  private unsubscribe: (() => void) | null = null
  private started = false

  constructor(private readonly opts: RoutineServiceOptions) {
    this.now = opts.now ?? Date.now
    this.routinesDir = join(opts.root, 'routines')
    this.runsDir = join(this.routinesDir, 'runs')
    this.store = new RoutineStore({ root: this.routinesDir, now: this.now, watch: opts.watch ?? true })
    this.log = new RoutineRunLog({ path: join(this.routinesDir, 'runs.json') })
    this.runner = new RoutineRunner({
      store: this.store, log: this.log, executor: opts.executor, runsDir: this.runsDir,
      indexDir: opts.indexDir ?? defaultIndexDir(), excludeCwdPart: this.runsDir,
      agentProvider: () => opts.agentProvider(), now: this.now, onChange: () => this.emit(),
    })
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.runsDir, { recursive: true })
    await this.store.load()
    await this.log.load()
    // Hand edits reload the store, which already recomputes nextFireAt for a changed schedule.
    this.unsubscribe = this.store.onChange(() => {
      this.emit()
      if (this.started) void this.runner.wake().catch(() => {})
    })
    if (this.opts.enabled) {
      await this.runner.start()
      this.started = true
    }
    this.emit()
  }

  view(): RoutinesView {
    const runs = [...this.log.all()].sort((a, b) => a.firedAt - b.firedAt).slice(-VIEW_RUNS)
    return {
      available: this.opts.enabled, ...(this.opts.enabled ? {} : { reason: OFF_REASON }),
      items: this.list(), runs,
    }
  }

  list(): RoutineItemView[] {
    return this.store.list()
      .map(entry => this.item(entry))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }

  async create(fields: RoutineFields): Promise<{ item: RoutineItemView; definitionPath: string }> {
    this.requireEnabled()
    const entry = await this.store.create(fields)
    this.emit()
    return { item: this.item(entry), definitionPath: entry.path }
  }

  async update(id: string, fields: Partial<RoutineFields>): Promise<RoutineItemView> {
    this.requireEnabled()
    const entry = await this.store.update(id, fields)
    this.emit()
    return this.item(entry)
  }

  async remove(id: string): Promise<void> {
    this.requireEnabled()
    await this.store.remove(id)
    this.emit()
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    this.requireEnabled()
    await this.store.setEnabled(id, enabled)
    this.emit()
  }

  async runNow(id: string): Promise<RoutineRun> { this.requireEnabled(); return this.runner.runNow(id) }
  async event(e: MeetingNotesEvent): Promise<RoutineRun[]> { this.requireEnabled(); return this.runner.event(e) }
  async wake(): Promise<void> { this.requireEnabled(); return this.runner.wake() }
  async cancel(runId: string): Promise<boolean> { this.requireEnabled(); return this.runner.cancel(runId) }
  async markRead(): Promise<void> { this.requireEnabled(); return this.runner.markRead() }
  async decideProposal(runId: string, proposalId: string, decision: 'approve' | 'dismiss'): Promise<RoutineRun | null> {
    this.requireEnabled()
    return this.runner.decideProposal(runId, proposalId, decision)
  }

  run(runId: string): RoutineRun | undefined {
    return this.log.get(runId)
  }

  /** Newest first, for the Agent's `routine_runs` tool. */
  runs(opts: { routineId?: string; limit?: number } = {}): RoutineRun[] {
    const runs = this.log.all()
      .filter(r => !opts.routineId || r.routineId === opts.routineId)
      .sort((a, b) => b.firedAt - a.firedAt)
    return opts.limit === undefined ? runs : runs.slice(0, opts.limit)
  }

  async result(runId: string): Promise<string | null> {
    const path = this.log.get(runId)?.resultPath
    if (!path) return null
    return fs.readFile(path, 'utf8').catch(() => null)
  }

  definitionPath(id: string): string {
    return this.store.get(id)?.path ?? join(this.routinesDir, `${id}.md`)
  }

  async close(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.store.close()
    if (this.started) await this.runner.dispose()
    this.started = false
    await this.opts.executor.dispose()
  }

  private requireEnabled(): void {
    if (!this.opts.enabled) throw new Error(OFF_REASON)
  }

  private emit(): void {
    this.opts.emit(this.view())
  }

  private item(entry: RoutineEntry): RoutineItemView {
    const d = entry.definition
    const runs = this.log.all().filter(r => r.routineId === entry.id)
    let last: RoutineRun | undefined
    for (const run of runs) {
      if (TERMINAL.has(run.status) && (!last || run.firedAt > last.firedAt)) last = run
    }
    const nextRunLabel = !entry.state.enabled ? 'Paused'
      : !d ? "Can't run until the file is fixed"
      : d.schedule.type === 'event' ? 'After your next meeting'
      : describeNext(entry.state.nextFireAt, this.now())
    return {
      id: entry.id, name: d?.name ?? entry.id, scheduleLabel: d ? describeSchedule(d.schedule) : '',
      window: d ? formatWindow(d.window) : '',
      kind: d?.kind ?? 'read-only', enabled: entry.state.enabled, nextRunAt: entry.state.nextFireAt, nextRunLabel,
      ...(last ? { lastRun: { status: last.status, at: last.endedAt ?? last.firedAt } } : {}),
      running: runs.some(r => r.status === 'queued' || r.status === 'running'),
      ...(entry.error !== undefined ? { error: entry.error } : {}), path: entry.path,
    }
  }
}
