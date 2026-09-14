import { type Schedule, parseSchedule, formatSchedule } from './schedule'
import { type WindowRule, parseWindow, formatWindow } from './window'

export type RoutineKind = 'read-only' | 'takes-actions'
export type RoutineInput = 'sessions' | 'memory' | 'meetings' | 'dictation'
export interface RoutineDefinition {
  id: string; name: string; schedule: Schedule; window: WindowRule; kind: RoutineKind
  provider: 'agent' | 'claude' | 'codex'; inputs: RoutineInput[]; whenEmpty: 'note' | 'silent'
  maxMinutes: number; speak: boolean; prompt: string
}
export interface RoutineFields {
  name: string; schedule: string; prompt: string; window?: string; kind?: RoutineKind
  provider?: 'agent' | 'claude' | 'codex'; inputs?: RoutineInput[]; whenEmpty?: 'note' | 'silent'; maxMinutes?: number; speak?: boolean
}

export const ROUTINE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

const KEYS = ['name', 'schedule', 'window', 'kind', 'provider', 'inputs', 'when-empty', 'max-minutes', 'speak'] as const
const KINDS: readonly RoutineKind[] = ['read-only', 'takes-actions']
const PROVIDERS = ['agent', 'claude', 'codex'] as const
const INPUTS: readonly RoutineInput[] = ['sessions', 'memory', 'meetings', 'dictation']
const WHEN_EMPTY = ['note', 'silent'] as const

export function slugify(name: string, taken: ReadonlySet<string>): string {
  let base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  if (!/^[a-z0-9]/.test(base)) base = 'routine'
  if (!taken.has(base)) return base
  let n = 2
  let candidate = `${base}-${n}`
  while (taken.has(candidate)) {
    n++
    const suffix = `-${n}`
    candidate = base.slice(0, 64 - suffix.length) + suffix
  }
  return candidate
}

export function definitionFromFields(id: string, fields: RoutineFields): RoutineDefinition {
  const name = (fields.name ?? '').trim()
  if (!name || name.length > 60) throw new Error('A routine needs a name between 1 and 60 characters')

  const prompt = (fields.prompt ?? '').trim()
  if (!prompt || prompt.length > 20_000) throw new Error('A routine needs a prompt between 1 and 20,000 characters')

  const schedule = parseSchedule(fields.schedule)

  const kind = fields.kind ?? 'read-only'
  if (!KINDS.includes(kind)) throw new Error(`"${kind}" is not a kind; use read-only or takes-actions`)

  const provider = fields.provider ?? 'agent'
  if (!PROVIDERS.includes(provider)) throw new Error(`"${provider}" is not a provider; use agent, claude or codex`)
  if (kind === 'takes-actions' && provider === 'codex') {
    throw new Error('takes-actions routines always run Claude; set provider to claude or agent')
  }

  const inputs = fields.inputs ?? ['sessions']
  for (const input of inputs) {
    if (!INPUTS.includes(input)) throw new Error(`"${input}" is not an input; use sessions, memory, meetings or dictation`)
  }

  const whenEmpty = fields.whenEmpty ?? 'note'
  if (!WHEN_EMPTY.includes(whenEmpty)) throw new Error(`"${whenEmpty}" is not a when-empty value; use note or silent`)

  const maxMinutes = fields.maxMinutes ?? 10
  if (!Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 30) {
    throw new Error('max-minutes must be between 1 and 30')
  }

  const speak = fields.speak ?? false

  const windowDefault: WindowRule = schedule.type === 'event' ? { type: 'none' } : { type: 'yesterday-or-last-run' }
  const window = fields.window !== undefined ? parseWindow(fields.window) : windowDefault

  return { id, name, schedule, window, kind, provider, inputs: [...inputs], whenEmpty, maxMinutes, speak, prompt }
}

export function parseDefinition(id: string, text: string): RoutineDefinition {
  if (!text.startsWith('---\n')) throw new Error('A routine file must start with "---"')
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) throw new Error('A routine file\'s frontmatter must be closed with "---"')
  const frontmatter = text.slice(4, end)
  const body = text.slice(end + 5)

  const raw: Record<string, string> = {}
  for (const line of frontmatter.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const sep = line.indexOf(': ')
    if (sep < 0) throw new Error(`Malformed frontmatter line "${line}"`)
    const key = line.slice(0, sep).trim()
    const value = line.slice(sep + 2).trim()
    if (!(KEYS as readonly string[]).includes(key)) throw new Error(`Unknown key "${key}"`)
    raw[key] = value
  }

  const fields: RoutineFields = { name: raw.name ?? '', schedule: raw.schedule ?? '', prompt: body.trim() }
  if (raw.window !== undefined) fields.window = raw.window
  if (raw.kind !== undefined) fields.kind = raw.kind as RoutineKind
  if (raw.provider !== undefined) fields.provider = raw.provider as RoutineFields['provider']
  if (raw.inputs !== undefined) fields.inputs = raw.inputs.split(',').map(s => s.trim()) as RoutineInput[]
  if (raw['when-empty'] !== undefined) fields.whenEmpty = raw['when-empty'] as RoutineFields['whenEmpty']
  if (raw['max-minutes'] !== undefined) fields.maxMinutes = Number(raw['max-minutes'])
  if (raw.speak !== undefined) {
    if (raw.speak !== 'true' && raw.speak !== 'false') throw new Error(`"${raw.speak}" is not true or false`)
    fields.speak = raw.speak === 'true'
  }

  return definitionFromFields(id, fields)
}

export function serializeDefinition(d: RoutineDefinition): string {
  const lines = [
    `name: ${d.name}`,
    `schedule: ${formatSchedule(d.schedule)}`,
    `window: ${formatWindow(d.window)}`,
    `kind: ${d.kind}`,
    `provider: ${d.provider}`,
    `inputs: ${d.inputs.join(', ')}`,
    `when-empty: ${d.whenEmpty}`,
    `max-minutes: ${d.maxMinutes}`,
    `speak: ${d.speak}`,
  ]
  return `---\n${lines.join('\n')}\n---\n${d.prompt}\n`
}
