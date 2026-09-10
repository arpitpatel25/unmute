import { createLogger } from './log'

/** Working-tree-only build switch. Release builds commit this as false. */
export const SESSION_LIFECYCLE_DEV_LOG = false

const forbidden = /prompt|text|content|token|authorization|secret|credential|header/i
type Field = string | number | boolean | null

export function sanitizeSessionLifecycleFields(fields: Record<string, unknown>): Record<string, Field> {
  const safe: Record<string, Field> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (forbidden.test(key)) continue
    if (value === null || typeof value === 'number' || typeof value === 'boolean') safe[key] = value
    else if (typeof value === 'string') safe[key] = value.slice(0, 160)
  }
  return safe
}

export function sessionLifecycleDev(event: string, fields: Record<string, unknown> = {}): void {
  if (!SESSION_LIFECYCLE_DEV_LOG) return
  createLogger('session-lifecycle-dev').event(event, sanitizeSessionLifecycleFields(fields))
}
