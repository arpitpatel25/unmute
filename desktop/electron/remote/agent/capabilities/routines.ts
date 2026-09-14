import type {
  CapabilityCallContext,
  CapabilityModule,
  ToolDefinition,
  ToolResult,
} from '../types'
import { INPUTS, KINDS, PROVIDERS, WHEN_EMPTY, type RoutineFields, type RoutineInput, type RoutineKind } from '../routines/definition'
import type { RoutineService } from '../routines/service'
import type { RoutineItemView } from '../routines/types'

/**
 * Routines are separate one-shot sessions the Agent never runs inline — this
 * capability only ever creates, edits and inspects them; the constitution
 * carries the "you never run a routine's work inside this conversation" rule.
 *
 * `window` in a create/update result comes straight off `RoutineItemView.window`
 * (the service's own canonical `formatWindow` text) — never recomputed here,
 * so an update that only renames or reschedules still reports the routine's
 * actual persisted window, not a guessed default.
 */

const SCHEDULE_GRAMMAR = '`daily HH:MM` · `weekdays HH:MM` · `weekends HH:MM` · `mon,wed,fri HH:MM`'
  + ' (any of mon..sun) · `every N minutes` (N ≥ 15) · `every N hours` · `on meeting-notes-ready`'
const WINDOW_GRAMMAR = '`yesterday-or-last-run` · `since-last-run` · `today` · `last N hours` · `last N days`'
  + ' (N ≤ 30) · `none`'

const FIELD_PROPERTIES = {
  name: { type: 'string', minLength: 1, maxLength: 60, description: 'A short label for the routine, 1-60 characters.' },
  schedule: { type: 'string', minLength: 1, description: `When it fires: ${SCHEDULE_GRAMMAR}` },
  prompt: { type: 'string', minLength: 1, maxLength: 20_000, description: 'What to ask it to do each time it runs, 1-20,000 characters.' },
  window: {
    type: 'string',
    description: `How far back it looks, in local time: ${WINDOW_GRAMMAR}. Defaults to`
      + ' yesterday-or-last-run for clock schedules, none for on meeting-notes-ready.',
  },
  kind: {
    type: 'string', enum: KINDS,
    description: 'read-only never touches anything outside this conversation; takes-actions may act'
      + ' through Chrome and always actually runs Claude. Defaults to read-only.',
  },
  provider: {
    type: 'string', enum: PROVIDERS,
    description: "Which provider runs it: agent follows the Agent's own selected provider at run time,"
      + ' or pin claude or codex. takes-actions requires claude or agent. Defaults to agent.',
  },
  inputs: {
    type: 'array', items: { type: 'string', enum: INPUTS },
    description: 'Which inputs it is given. Defaults to [sessions].',
  },
  whenEmpty: {
    type: 'string', enum: WHEN_EMPTY,
    description: 'What happens when nothing falls in the window: note posts a one-line "Nothing since …",'
      + ' silent posts nothing at all. Defaults to note.',
  },
  maxMinutes: { type: 'integer', minimum: 1, maximum: 30, description: 'Minutes before the run is interrupted as timed out. Defaults to 10.' },
  speak: { type: 'boolean', description: "Announce the result aloud when it finishes. Defaults to false." },
} as const

const FIELD_KEYS = Object.keys(FIELD_PROPERTIES) as (keyof typeof FIELD_PROPERTIES)[]

/** Shared by every tool that takes nothing but an id: pause, resume, delete, run_now. */
const ID_INPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', minLength: 1, description: 'The routine id, from routine_list.' } },
} as const

const tools = [
  {
    name: 'routine_list',
    description: 'Every routine: id, name, schedule in words, kind, enabled, next run, last run, and any'
      + ' parse error. Call this before updating, pausing, resuming, deleting or running one now, so you'
      + ' have the exact id.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    consequence: 'read',
  },
  {
    name: 'routine_runs',
    description: 'Recent routine runs, newest first, optionally restricted to one routine id. Full result'
      + ' text is included for the newest done runs (up to 5), so a second lookup is rarely needed.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1, description: 'Restrict to runs of this routine id.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many runs to return, newest first. Defaults to 10.' },
      },
    },
    consequence: 'read',
  },
  {
    name: 'routine_create',
    description: 'Create a routine — a saved prompt that runs on its own as a separate session, on a'
      + ' schedule or event. Create one when asked for anything recurring or triggered. Validates the'
      + ' schedule and window grammar, writes the definition file, and returns the parsed preview plus'
      + ' the next run in words — confirm schedule, window and kind back to the user in one line.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['name', 'schedule', 'prompt'],
      properties: FIELD_PROPERTIES,
    },
    consequence: 'reversible-write',
  },
  {
    name: 'routine_update',
    description: 'Change an existing routine. Give the id from routine_list plus only the fields that'
      + ' change; anything omitted is left as it was. Returns the same parsed preview as routine_create.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: { id: { type: 'string', minLength: 1, description: 'The routine id, from routine_list.' }, ...FIELD_PROPERTIES },
    },
    consequence: 'reversible-write',
  },
  {
    name: 'routine_pause',
    description: 'Turn off a routine so it stops firing on its own schedule or event. Its definition and'
      + ' run history are kept; routine_resume turns it back on.',
    inputSchema: ID_INPUT_SCHEMA,
    consequence: 'reversible-write',
  },
  {
    name: 'routine_resume',
    description: 'Turn a paused routine back on.',
    inputSchema: ID_INPUT_SCHEMA,
    consequence: 'reversible-write',
  },
  {
    name: 'routine_delete',
    description: 'Delete a routine. It moves to .trash and can be recovered by hand; it never fires again once deleted.',
    inputSchema: ID_INPUT_SCHEMA,
    consequence: 'reversible-write',
  },
  {
    name: 'routine_run_now',
    description: "Fire a routine immediately, outside its schedule, as its own separate run. Returns the"
      + ' new run id; check on it with routine_runs. You do not do the routine\'s work yourself and you'
      + ' do not wait for it here.',
    inputSchema: ID_INPUT_SCHEMA,
    consequence: 'reversible-write',
  },
] as const satisfies readonly ToolDefinition[]

/** The narrow slice of `RoutineService` this capability needs, so tests can fake it. */
export type RoutinesServiceLike = Pick<RoutineService, 'list' | 'create' | 'update' | 'remove' | 'setEnabled' | 'runNow' | 'runs' | 'result'>

function ok(result: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
}
function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function object(input: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Input must be an object')
  const value = input as Record<string, unknown>
  const missing = required.find((key) => !Object.hasOwn(value, key))
  if (missing) throw new Error(`"${missing}" is required`)
  const extra = Object.keys(value).find((key) => !allowed.includes(key))
  if (extra) throw new Error(`Unknown field "${extra}"`)
  return value
}

function string(value: unknown, key: string): string {
  if (typeof value !== 'string') throw new Error(`"${key}" must be a string`)
  return value
}
function enumString<T extends string>(value: unknown, key: string, allowed: readonly T[]): T {
  const text = string(value, key)
  if (!(allowed as readonly string[]).includes(text)) throw new Error(`"${key}" must be one of: ${allowed.join(', ')}`)
  return text as T
}
function enumStringArray<T extends string>(value: unknown, key: string, allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) throw new Error(`"${key}" must be an array`)
  return value.map((item) => enumString(item, key, allowed))
}
function integer(value: unknown, key: string): number {
  if (!Number.isInteger(value)) throw new Error(`"${key}" must be an integer`)
  return value as number
}
function boolean(value: unknown, key: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`"${key}" must be a boolean`)
  return value
}

/** Builds a `Partial<RoutineFields>` from whichever of the shared fields are present.
 *  For `routine_create`, `object()` has already required name/schedule/prompt. */
function parseFields(value: Record<string, unknown>): Partial<RoutineFields> {
  const fields: Partial<RoutineFields> = {}
  if (value.name !== undefined) fields.name = string(value.name, 'name')
  if (value.schedule !== undefined) fields.schedule = string(value.schedule, 'schedule')
  if (value.prompt !== undefined) fields.prompt = string(value.prompt, 'prompt')
  if (value.window !== undefined) fields.window = string(value.window, 'window')
  if (value.kind !== undefined) fields.kind = enumString<RoutineKind>(value.kind, 'kind', KINDS)
  if (value.provider !== undefined) fields.provider = enumString(value.provider, 'provider', PROVIDERS)
  if (value.inputs !== undefined) fields.inputs = enumStringArray<RoutineInput>(value.inputs, 'inputs', INPUTS)
  if (value.whenEmpty !== undefined) fields.whenEmpty = enumString(value.whenEmpty, 'whenEmpty', WHEN_EMPTY)
  if (value.maxMinutes !== undefined) fields.maxMinutes = integer(value.maxMinutes, 'maxMinutes')
  if (value.speak !== undefined) fields.speak = boolean(value.speak, 'speak')
  return fields
}

function idFrom(input: unknown): string {
  return string(object(input, ['id'], ['id']).id, 'id')
}

function parseLimit(value: unknown): number {
  if (value === undefined) return 10
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 20) {
    throw new Error('"limit" must be an integer between 1 and 20')
  }
  return value as number
}

function preview(item: RoutineItemView, file: string) {
  return {
    id: item.id, name: item.name, schedule: item.scheduleLabel, window: item.window,
    kind: item.kind, nextRun: item.nextRunLabel, file,
  }
}

const NOT_FOUND = /^Routine ".*" was not found$/

/** Converts the service's generic "was not found" into the tool contract's exact wording,
 *  and leaves every other thrown error (a validation error) to pass through unchanged so
 *  `call()`'s catch can report it as isError text, never a throw. */
async function guardId<T>(id: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (NOT_FOUND.test(message)) throw new Error(`No routine with id "${id}". Use routine_list.`)
    throw error
  }
}

export class RoutinesCapability implements CapabilityModule {
  readonly id = 'routines'
  readonly roles = ['unmute-agent'] as const
  readonly tools = tools

  constructor(private readonly service: RoutinesServiceLike) {}

  async call(ctx: CapabilityCallContext, tool: string, input: unknown): Promise<ToolResult> {
    if (ctx.principal.kind !== 'unmute-agent' || ctx.principal.expiresAt <= ctx.now) {
      return fail('Routines are unavailable')
    }
    try {
      switch (tool) {
        case 'routine_list':
          return ok(this.service.list())

        case 'routine_runs':
          return ok(await this.runsView(input))

        case 'routine_create': {
          const value = object(input, FIELD_KEYS, ['name', 'schedule', 'prompt'])
          const fields = parseFields(value) as RoutineFields
          const { item, definitionPath } = await this.service.create(fields)
          return ok(preview(item, definitionPath))
        }

        case 'routine_update': {
          const value = object(input, ['id', ...FIELD_KEYS], ['id'])
          const id = string(value.id, 'id')
          const fields = parseFields(value)
          const item = await guardId(id, () => this.service.update(id, fields))
          return ok(preview(item, item.path))
        }

        case 'routine_pause': {
          const id = idFrom(input)
          await guardId(id, () => this.service.setEnabled(id, false))
          return ok({ id, enabled: false })
        }

        case 'routine_resume': {
          const id = idFrom(input)
          await guardId(id, () => this.service.setEnabled(id, true))
          return ok({ id, enabled: true })
        }

        case 'routine_delete': {
          const id = idFrom(input)
          await guardId(id, () => this.service.remove(id))
          return ok({ id, status: 'deleted' })
        }

        case 'routine_run_now': {
          const id = idFrom(input)
          const run = await guardId(id, () => this.service.runNow(id))
          return ok({ runId: run.id, status: run.status })
        }

        default:
          return fail(`Unknown tool: ${tool}`)
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'Routine tool input is invalid')
    }
  }

  private async runsView(input: unknown): Promise<unknown[]> {
    const value = object(input ?? {}, ['id', 'limit'], [])
    const id = value.id === undefined ? undefined : string(value.id, 'id')
    const limit = parseLimit(value.limit)
    const runs = this.service.runs({ ...(id !== undefined ? { routineId: id } : {}), limit })

    const doneIds = runs.filter((run) => run.status === 'done').slice(0, Math.min(limit, 5)).map((run) => run.id)
    const results = new Map<string, string>()
    for (const runId of doneIds) {
      const text = await this.service.result(runId)
      if (text !== null) results.set(runId, text)
    }

    return runs.map((run) => ({
      runId: run.id,
      routine: run.name,
      status: run.status,
      firedAt: new Date(run.firedAt).toISOString(),
      ...(run.endedAt !== undefined ? { endedAt: new Date(run.endedAt).toISOString() } : {}),
      ...(run.window !== undefined ? { window: run.window.label } : {}),
      ...(run.resultPreview !== undefined ? { preview: run.resultPreview } : {}),
      ...(run.resultPath !== undefined ? { resultPath: run.resultPath } : {}),
      ...(results.has(run.id) ? { result: results.get(run.id) } : {}),
    }))
  }
}
