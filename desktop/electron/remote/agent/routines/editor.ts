import { definitionFromFields, parseRoutineContext, type RoutineFields, type RoutineInput } from './definition'

/** Native IPC uses string-valued form fields; decode and validate at the host boundary. */
export interface RoutineEditorFields {
  name: string; schedule: string; window: string; kind: string; prompt: string
  inputs?: string; context?: string
}
export function routineEditorFields(fields: RoutineEditorFields): RoutineFields {
  if (!fields || typeof fields !== 'object') throw new Error('Missing routine fields')
  for (const key of ['name', 'schedule', 'window', 'kind', 'prompt'] as const) {
    if (typeof fields[key] !== 'string') throw new Error(`Invalid routine ${key}`)
  }
  const result: RoutineFields = {
    name: fields.name, schedule: fields.schedule, window: fields.window, prompt: fields.prompt,
    kind: fields.kind as RoutineFields['kind'],
    ...(fields.inputs !== undefined ? { inputs: JSON.parse(fields.inputs) as RoutineInput[] } : {}),
    ...(fields.context !== undefined ? { context: parseRoutineContext(JSON.parse(fields.context)) } : {}),
  }
  definitionFromFields('validate', result)
  return result
}
