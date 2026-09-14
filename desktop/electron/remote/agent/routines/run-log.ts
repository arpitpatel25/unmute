import { promises as fs } from 'node:fs'
import { writeFileAtomic } from './atomic'
import type { RoutineRun, RunStatus } from './types'

const TERMINAL: ReadonlySet<RunStatus> = new Set(['done', 'failed', 'cancelled', 'skipped'])

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export class RoutineRunLog {
  private readonly path: string
  private readonly max: number
  private readonly persist: (path: string, content: string) => Promise<void>
  private runs: RoutineRun[] = []
  private chain: Promise<void> = Promise.resolve()

  constructor(opts: { path: string; max?: number; persist?: (path: string, content: string) => Promise<void> }) {
    this.path = opts.path
    this.max = opts.max ?? 500
    this.persist = opts.persist ?? writeFileAtomic
  }

  async load(): Promise<RoutineRun[]> {
    let text: string
    try {
      text = await fs.readFile(this.path, 'utf8')
    } catch (error) {
      if (isNotFound(error)) { this.runs = []; return this.runs }
      throw error
    }
    try {
      const parsed = JSON.parse(text)
      if (!Array.isArray(parsed)) throw new Error('runs.json is not an array')
      this.runs = parsed as RoutineRun[]
    } catch {
      await fs.rename(this.path, `${this.path}.corrupt-${Date.now()}`)
      this.runs = []
    }
    return this.runs
  }

  all(): RoutineRun[] {
    return this.runs
  }

  get(id: string): RoutineRun | undefined {
    return this.runs.find(r => r.id === id)
  }

  hasKey(key: string): boolean {
    return this.runs.some(r => r.key === key)
  }

  // `next` is what THIS call reports to its caller: it rejects if the write
  // fails. `this.chain` is what later calls wait on before starting their own
  // write; it is wrapped in `.catch(() => {})` so one failed write can never
  // stall every upsert queued after it (a chain built from unwrapped
  // rejections stops running its `.then` callbacks forever after the first).
  upsert(run: RoutineRun): Promise<void> {
    const next = this.chain.then(() => this.write(run))
    this.chain = next.catch(() => {})
    return next
  }

  private trim(runs: RoutineRun[]): RoutineRun[] {
    const result = [...runs]
    while (result.length > this.max) {
      const index = result.findIndex(r => TERMINAL.has(r.status))
      if (index < 0) break
      result.splice(index, 1)
    }
    return result
  }

  private async write(run: RoutineRun): Promise<void> {
    const index = this.runs.findIndex(r => r.id === run.id)
    const next = index >= 0 ? this.runs.map((r, i) => (i === index ? run : r)) : [...this.runs, run]
    const trimmed = this.trim(next)
    // Only commit to `this.runs` once the write actually lands, so a failed
    // write leaves in-memory state matching what's still on disk.
    await this.persist(this.path, JSON.stringify(trimmed))
    this.runs = trimmed
  }

  lastSuccess(routineId: string): RoutineRun | undefined {
    let best: RoutineRun | undefined
    for (const run of this.runs) {
      if (run.routineId !== routineId) continue
      const success = run.status === 'done' || (run.status === 'skipped' && run.reason === 'nothing-in-window')
      if (!success) continue
      if (!best || run.firedAt > best.firedAt) best = run
    }
    return best
  }
}
