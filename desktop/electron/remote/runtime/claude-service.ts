import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudeTaskSession, type ClaudeTaskOptions, type ClaudeTaskEvent } from '../claude/task-session'

export interface ClaudeRuntimeState {
  alive: boolean
  busy: boolean
  activeSubmissionId?: string
  followupBlocked: boolean
  followupUnavailable: boolean
  pid?: number
  models: ClaudeTaskSession['models']
}
export interface ClaudeRuntimeEvent {
  sessionId: string
  sequence: number
  event: ClaudeTaskEvent
  state: ClaudeRuntimeState
}
type Entry = { driver: ClaudeTaskSession; events: ClaudeRuntimeEvent[]; opening: Promise<void>; opened: boolean }

/** Owns both stdio and approval continuations, including while no UI exists. */
export class ClaudeRuntimeService {
  private sessions = new Map<string, Entry>()
  constructor(private root: string, private emit: (event: ClaudeRuntimeEvent) => void,
    private makeDriver: (options: ClaudeTaskOptions) => ClaudeTaskSession = options => new ClaudeTaskSession(options)) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
  }
  async invoke(method: string, args: any[]): Promise<unknown> {
    if (method === 'list') return [...this.sessions].map(([sessionId, entry]) => ({ sessionId, ...this.state(entry.driver) }))
    const [id, ...rest] = args
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid runtime session identity')
    if (method === 'open') {
      let entry = this.sessions.get(id)
      if (!entry || (entry.opened && !entry.driver.alive)) {
        const options = rest[0] as ClaudeTaskOptions
        if (options.sessionId !== id) throw new Error('Provider session identity mismatch')
        const events: ClaudeRuntimeEvent[] = entry?.events ?? []
        const driver = this.makeDriver({ ...options, onEvent: event => {
          const record = { sessionId: id, sequence: events.length + 1, event, state: this.state(driver) }
          // Runtime receipts survive a daemon crash; only a live daemon can
          // claim that the old process is still executing.
          appendFileSync(join(this.root, `${id}.jsonl`), JSON.stringify(record) + '\n', { mode: 0o600 })
          events.push(record)
          this.emit(record)
        } })
        entry = { driver, events, opening: Promise.resolve(), opened: false }
        this.sessions.set(id, entry)
        const current = entry
        entry.opening = driver.start().finally(() => { current.opened = true })
      }
      await entry.opening
      return { ...this.state(entry.driver), sequence: entry.events.length }
    }
    const entry = this.sessions.get(id)
    if (!entry) throw new Error('The provider runtime no longer exists; recover the conversation before submitting')
    const driver = entry.driver
    switch (method) {
      case 'replay': return entry.events.slice(Number(rest[0]) || 0, (Number(rest[0]) || 0) + 100)
      case 'state': return this.state(driver)
      case 'send': return driver.send(rest[0], rest[1], rest[2], rest[3], rest[4])
      case 'sendNewTurn': return driver.sendNewTurn(rest[0], rest[1], rest[2], rest[3])
      case 'answer': await driver.answer(rest[0], rest[1]); return this.state(driver)
      case 'interrupt': await driver.interrupt(); return this.state(driver)
      case 'close': driver.close(); return this.state(driver)
      default: throw new Error('Unknown Claude runtime method')
    }
  }
  private state(driver: ClaudeTaskSession): ClaudeRuntimeState {
    return { alive: driver.alive, busy: driver.busy, activeSubmissionId: driver.activeSubmissionId,
      followupBlocked: driver.followupBlocked, followupUnavailable: driver.followupUnavailable,
      pid: driver.pid, models: driver.models }
  }
  close(): void { for (const entry of this.sessions.values()) entry.driver.close() }
}
