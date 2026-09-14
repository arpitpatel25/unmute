import { promises as fs, mkdirSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { join, sep } from 'node:path'
import { diagnostic, diagnosticError } from '../../diagnostics'
import { nextFireAt, formatSchedule } from './schedule'
import { formatWindow } from './window'
import { writeFileAtomic } from './atomic'
import {
  type RoutineDefinition, type RoutineFields, ROUTINE_ID, parseDefinition, definitionFromFields, serializeDefinition, slugify,
} from './definition'
import type { RoutineEntry, RoutineState } from './types'

const STATE_FILE = 'state.json'
const TRASH_DIR = '.trash'
/** Siblings the routines service keeps in this directory; none of them is a definition. */
const NOT_DEFINITIONS = ['runs.json', 'runs', 'agent-journal']
const DEBOUNCE_MS = 200
const INVALID_NAME_ERROR = 'File name must be lowercase letters, numbers and dashes'

interface PersistedRoutineState extends RoutineState { scheduleText?: string }
interface PersistedState { version: 1; routines: Record<string, PersistedRoutineState> }

function fieldsFromDefinition(d: RoutineDefinition): RoutineFields {
  return {
    name: d.name, schedule: formatSchedule(d.schedule), prompt: d.prompt, window: formatWindow(d.window),
    kind: d.kind, provider: d.provider, inputs: d.inputs, whenEmpty: d.whenEmpty, maxMinutes: d.maxMinutes, speak: d.speak,
  }
}

export class RoutineStore {
  private readonly routinesDir: string
  private readonly trashDir: string
  private readonly statePath: string
  private readonly now: () => number
  private readonly watchEnabled: boolean
  private readonly onError: (error: unknown) => void
  private entries = new Map<string, RoutineEntry>()
  private state: PersistedState = { version: 1, routines: {} }
  private watcher: FSWatcher | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private listeners = new Set<() => void>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(opts: { root: string; now?: () => number; watch?: boolean; onError?: (error: unknown) => void }) {
    this.routinesDir = opts.root
    this.trashDir = join(opts.root, TRASH_DIR)
    this.statePath = join(opts.root, STATE_FILE)
    this.now = opts.now ?? Date.now
    this.watchEnabled = opts.watch ?? true
    this.onError = opts.onError ?? (error => diagnostic('routines-store-reload-failed', diagnosticError(error)))
    // Synchronous so onChange() can fs.watch the directory right after
    // construction without forcing every caller to await load() first.
    mkdirSync(this.routinesDir, { recursive: true })
    mkdirSync(this.trashDir, { recursive: true })
  }

  /** Every read-then-write of state.json runs on one chain, so a watcher reload can never read
   *  state.json before an in-flight write lands and then overwrite the newer in-memory state. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn)
    this.chain = next.catch(() => {})
    return next
  }

  load(): Promise<RoutineEntry[]> { return this.exclusive(() => this.loadNow()) }
  private async loadNow(): Promise<RoutineEntry[]> {
    const state = await this.readState()
    const names = (await fs.readdir(this.routinesDir)).filter(f => f.endsWith('.md')).sort()
    const entries = new Map<string, RoutineEntry>()
    const seen = new Set<string>()

    for (const name of names) {
      const id = name.slice(0, -'.md'.length)
      seen.add(id)
      const path = join(this.routinesDir, name)
      const prior = state.routines[id]

      let definition: RoutineDefinition | undefined
      let error: string | undefined
      if (!ROUTINE_ID.test(id)) {
        error = INVALID_NAME_ERROR
      } else {
        try {
          definition = parseDefinition(id, await fs.readFile(path, 'utf8'))
        } catch (e) {
          error = (e as Error).message
        }
      }

      let enabled = prior?.enabled ?? true
      let fireAt = prior?.nextFireAt ?? null
      if (definition) {
        const scheduleText = formatSchedule(definition.schedule)
        if (!prior || prior.scheduleText !== scheduleText) fireAt = nextFireAt(definition.schedule, this.now())
        state.routines[id] = { enabled, nextFireAt: fireAt, scheduleText }
      } else {
        state.routines[id] = prior ?? { enabled, nextFireAt: fireAt }
      }

      entries.set(id, {
        id, path, state: { enabled, nextFireAt: fireAt },
        ...(definition ? { definition } : {}), ...(error !== undefined ? { error } : {}),
      })
    }

    for (const id of Object.keys(state.routines)) {
      if (!seen.has(id)) delete state.routines[id]
    }

    this.state = state
    await this.writeState()
    this.entries = entries
    return this.list()
  }

  list(): RoutineEntry[] {
    return [...this.entries.values()]
  }

  get(id: string): RoutineEntry | undefined {
    return this.entries.get(id)
  }

  create(fields: RoutineFields): Promise<RoutineEntry> { return this.exclusive(() => this.createNow(fields)) }
  private async createNow(fields: RoutineFields): Promise<RoutineEntry> {
    const id = slugify(fields.name ?? '', new Set(this.entries.keys()))
    const definition = definitionFromFields(id, fields)
    const path = join(this.routinesDir, `${id}.md`)
    await writeFileAtomic(path, serializeDefinition(definition))

    const scheduleText = formatSchedule(definition.schedule)
    const fireAt = nextFireAt(definition.schedule, this.now())
    this.state.routines[id] = { enabled: true, nextFireAt: fireAt, scheduleText }
    await this.writeState()

    const entry: RoutineEntry = { id, path, definition, state: { enabled: true, nextFireAt: fireAt } }
    this.entries.set(id, entry)
    return entry
  }

  update(id: string, fields: Partial<RoutineFields>): Promise<RoutineEntry> { return this.exclusive(() => this.updateNow(id, fields)) }
  private async updateNow(id: string, fields: Partial<RoutineFields>): Promise<RoutineEntry> {
    const entry = this.entries.get(id)
    if (!entry?.definition) throw new Error(`Routine "${id}" was not found`)

    const merged: RoutineFields = { ...fieldsFromDefinition(entry.definition), ...fields }
    const definition = definitionFromFields(id, merged)
    await writeFileAtomic(entry.path, serializeDefinition(definition))

    const scheduleText = formatSchedule(definition.schedule)
    const prior = this.state.routines[id]
    const fireAt = !prior || prior.scheduleText !== scheduleText ? nextFireAt(definition.schedule, this.now()) : prior.nextFireAt
    const enabled = prior?.enabled ?? true
    this.state.routines[id] = { enabled, nextFireAt: fireAt, scheduleText }
    await this.writeState()

    const updated: RoutineEntry = { id, path: entry.path, definition, state: { enabled, nextFireAt: fireAt } }
    this.entries.set(id, updated)
    return updated
  }

  remove(id: string): Promise<void> { return this.exclusive(() => this.removeNow(id)) }
  private async removeNow(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Routine "${id}" was not found`)
    await fs.rename(entry.path, join(this.trashDir, `${id}-${this.now()}.md`))
    delete this.state.routines[id]
    await this.writeState()
    this.entries.delete(id)
  }

  setEnabled(id: string, enabled: boolean): Promise<void> { return this.exclusive(() => this.setEnabledNow(id, enabled)) }
  private async setEnabledNow(id: string, enabled: boolean): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Routine "${id}" was not found`)

    let fireAt = entry.state.nextFireAt
    if (enabled && entry.definition && entry.definition.schedule.type !== 'event') {
      const now = this.now()
      if (fireAt === null || fireAt <= now) fireAt = nextFireAt(entry.definition.schedule, now)
    }

    const scheduleText = this.state.routines[id]?.scheduleText
    this.state.routines[id] = { enabled, nextFireAt: fireAt, ...(scheduleText !== undefined ? { scheduleText } : {}) }
    await this.writeState()

    this.entries.set(id, { ...entry, state: { enabled, nextFireAt: fireAt } })
  }

  setNextFireAt(id: string, at: number | null): Promise<void> { return this.exclusive(() => this.setNextFireAtNow(id, at)) }
  private async setNextFireAtNow(id: string, at: number | null): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Routine "${id}" was not found`)

    const scheduleText = this.state.routines[id]?.scheduleText
    this.state.routines[id] = { enabled: entry.state.enabled, nextFireAt: at, ...(scheduleText !== undefined ? { scheduleText } : {}) }
    await this.writeState()

    this.entries.set(id, { ...entry, state: { enabled: entry.state.enabled, nextFireAt: at } })
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    if (this.watchEnabled && !this.watcher) {
      this.watcher = fsWatch(this.routinesDir, (_event, filename) => {
        if (filename && this.ignoreChange(filename)) return
        this.scheduleReload()
      })
    }
    return () => { this.listeners.delete(listener) }
  }

  close(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null }
    if (this.watcher) { this.watcher.close(); this.watcher = null }
    this.listeners.clear()
  }

  private ignoreChange(filename: string): boolean {
    if (filename === STATE_FILE) return true
    if (NOT_DEFINITIONS.some(name => filename === name || filename.startsWith(`${name}${sep}`))) return true
    if (filename === TRASH_DIR || filename.startsWith(`${TRASH_DIR}${sep}`)) return true
    if (filename.includes('.tmp')) return true
    return false
  }

  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      // A self-write also lands here; reloading is idempotent so there is no
      // need to tell self-writes and external edits apart.
      this.load()
        .then(() => { for (const listener of this.listeners) listener() })
        .catch(error => this.onError(error))
    }, DEBOUNCE_MS)
  }

  private async readState(): Promise<PersistedState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, 'utf8'))
      if (parsed && parsed.version === 1 && parsed.routines && typeof parsed.routines === 'object') {
        return parsed as PersistedState
      }
    } catch {
      // missing or corrupt: start fresh
    }
    return { version: 1, routines: {} }
  }

  private writeState(): Promise<void> {
    return writeFileAtomic(this.statePath, JSON.stringify(this.state))
  }
}
