import { createHash } from 'node:crypto'
import { createLogger } from './log'

export type DiagnosticSink = (event: string, fields: Record<string, unknown>) => void
const log = createLogger('diagnostics')
export const diagnostic: DiagnosticSink = (event, fields) => {
  try { log.event(event, { pid: process.pid, ...fields }) } catch { /* logging cannot break execution */ }
}

/** Error text may contain tool arguments, credentials or document contents.
 * Keep classification, a stable fingerprint and call sites, never that text. */
export function diagnosticError(error: unknown): Record<string, unknown> {
  const value = error instanceof Error ? error : new Error(String(error))
  const code = (value as NodeJS.ErrnoException).code
  const header = `${value.name}: ${value.message}\n`
  const callSites = value.stack?.startsWith(header)
    ? value.stack.slice(header.length).split('\n').filter(line => /^\s+at /.test(line)).slice(0, 6).map(line => line.trim()) : []
  return { errorType: value.name, ...(code && /^[A-Z0-9_]+$/.test(code) ? { errorCode: code } : {}),
    errorFingerprint: createHash('sha256').update(value.message).digest('hex').slice(0, 16),
    callSites }
}
