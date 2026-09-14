import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { RoutineRun, RunStatus } from './types'

const TERMINAL: ReadonlySet<RunStatus> = new Set(['done', 'failed', 'cancelled', 'skipped'])

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export class RoutineRunLog {
  private readonly path: string
  private readonly max: number
  private runs: RoutineRun[] = []
  private chain: Promise<void> = Promise.resolve()

  constructor(opts: { path: string; max?: number }) {
    this.path = opts.path
    this.max = opts.max ?? 500
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

  // Writes are chained onto a single promise so concurrent upserts never race
  // to read-modify-write the same file — each write sees the prior one's result.
  upsert(run: RoutineRun): Promise<void> {
    this.chain = this.chain.then(() => this.write(run))
    return this.chain
  }

  private async write(run: RoutineRun): Promise<void> {
    const index = this.runs.findIndex(r => r.id === run.id)
    if (index >= 0) this.runs[index] = run
    else this.runs.push(run)
    this.trim()
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(this.runs), { mode: 0o600 })
    await fs.rename(tmp, this.path)
  }

  private trim(): void {
    while (this.runs.length > this.max) {
      const index = this.runs.findIndex(r => TERMINAL.has(r.status))
      if (index < 0) break
      this.runs.splice(index, 1)
    }
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
