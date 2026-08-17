// Unmute Remote — structured logging backbone.
//
// GOAL (per product owner): the logs must be thorough enough that, from the
// session logs ALONE, we can reconstruct exactly what a user experienced —
// including what they saw in the UI — without screenshots or the user
// describing it. Every meaningful state transition, every IPC message, every
// user-observable UI change, every PTY interaction, and every decision the
// router/manager makes MUST be logged.
//
// Design:
//   * Leveled (debug | info | warn | error) + two semantic channels:
//       - event(): a machine-meaningful state transition / decision
//       - ui():    something the user would SEE or HEAR change on screen
//     Both are just info-level lines tagged so they're greppable
//     (`grep ' ui '` reconstructs the visible experience;
//      `grep ' event '` reconstructs the internal state machine).
//   * Component-prefixed (`[remote:task-manager]`) and task-correlated
//     (every line for a task carries its taskId) so concurrent tasks
//     (PRD §4.4) never get tangled in the log.
//   * Dual sink: always console (so it shows in the Electron main-process
//     log / terminal), and — once configured from main — appended to a
//     per-run file under the logs dir so a whole session is captured.
//   * Zero dependencies. Safe to import from unit tests (file sink stays
//     off until explicitly configured, so tests don't write to disk).
//
// Usage:
//   import { createLogger } from './log'
//   const log = createLogger('task-manager')
//   const tlog = log.child({ taskId })           // correlate to one task
//   tlog.event('state-transition', { from: 'processing', to: 'done' })
//   tlog.ui('task-row.result-shown', { result })

import { appendFileSync, mkdirSync, createWriteStream, type WriteStream } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

interface LoggerConfig {
  minLevel: LogLevel
  fileStream: WriteStream | null
  // Mirror to console as well as file. Default true — we want both surfaces.
  console: boolean
}

// Module-level shared config — one process, one log file.
const config: LoggerConfig = {
  // debug by default: the product owner wants EVERYTHING captured. The file
  // sink keeps full firehose; the console can be quietened separately if noisy.
  minLevel: 'debug',
  fileStream: null,
  console: true,
}

let currentLogFilePath: string | null = null
/** The directory those logs live in — so a side-channel (the PTY tap) can write
 *  next to them instead of inventing its own location. */
let currentLogDir: string | null = null

/** Where run logs are being written, or null before configureRemoteLogging. */
export function remoteLogDir(): string | null { return currentLogDir }

/**
 * Configure the file sink. Call ONCE from the Electron main process at
 * startup (e.g. in initRemote). Until called, logs go to console only —
 * which is exactly what we want during unit tests.
 *
 * Returns the absolute path of the log file so the UI can offer "reveal logs".
 */
export function configureRemoteLogging(opts: { dir: string; runId: string; minLevel?: LogLevel }): string {
  try {
    mkdirSync(opts.dir, { recursive: true })
    currentLogDir = opts.dir
    const file = join(opts.dir, `remote-${opts.runId}.log`)
    config.fileStream = createWriteStream(file, { flags: 'a' })
    currentLogFilePath = file
    if (opts.minLevel) config.minLevel = opts.minLevel
    // First line of every run: a banner so log files are self-describing.
    const banner = `\n==== unmute-remote run ${opts.runId} @ ${new Date().toISOString()} ====\n`
    config.fileStream.write(banner)
    return file
  } catch (e) {
    // Never let logging setup crash the app — fall back to console-only.
    console.error('[remote:log] failed to open log file, console-only:', (e as Error).message)
    return ''
  }
}

export function getRemoteLogFilePath(): string | null {
  return currentLogFilePath
}

/** Set the console mirror on/off (file sink always keeps the firehose). */
export function setConsoleMirror(on: boolean): void {
  config.console = on
}

// ─── Serialization ──────────────────────────────────────────────
// One line per log record. Fields are JSON so the line is both
// human-skimmable and machine-parseable.

function serializeFields(fields?: Record<string, unknown>): string {
  if (!fields || Object.keys(fields).length === 0) return ''
  try {
    // Truncate any single huge string (e.g. a full transcript / PTY dump) so
    // one line can't blow up the log — but keep enough to be useful.
    const safe: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === 'string' && v.length > 2000) {
        safe[k] = v.slice(0, 2000) + `…<truncated ${v.length - 2000} chars>`
      } else {
        safe[k] = v
      }
    }
    return ' ' + JSON.stringify(safe)
  } catch {
    return ' {"_fields":"<unserializable>"}'
  }
}

function emit(
  level: LogLevel,
  component: string,
  baseFields: Record<string, unknown>,
  kind: '' | 'event' | 'ui',
  message: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[config.minLevel]) return

  const ts = new Date().toISOString()
  const taskId = baseFields.taskId !== undefined ? ` task=${baseFields.taskId}` : ''
  const kindTag = kind ? ` ${kind}` : ''
  // Merge base (child) fields with call fields; call fields win on conflict.
  const merged = { ...baseFields, ...(fields || {}) }
  // taskId is already in the prefix — don't duplicate it in the JSON blob.
  delete (merged as Record<string, unknown>).taskId
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [remote:${component}]${taskId}${kindTag} ${message}${serializeFields(merged)}`

  if (config.console) {
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    sink(line)
  }
  if (config.fileStream) {
    try { config.fileStream.write(line + '\n') } catch { /* never throw from logging */ }
  }
}

export interface RemoteLogger {
  /** Correlate all subsequent logs to a task (or any sub-scope). */
  child(fields: Record<string, unknown>): RemoteLogger
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
  /** A machine-meaningful state transition / decision. Reconstructs the state machine. */
  event(name: string, fields?: Record<string, unknown>): void
  /** Something the user SEES or HEARS change. Reconstructs the visible experience. */
  ui(name: string, fields?: Record<string, unknown>): void
}

function makeLogger(component: string, baseFields: Record<string, unknown>): RemoteLogger {
  return {
    child(fields) { return makeLogger(component, { ...baseFields, ...fields }) },
    debug(message, fields) { emit('debug', component, baseFields, '', message, fields) },
    info(message, fields) { emit('info', component, baseFields, '', message, fields) },
    warn(message, fields) { emit('warn', component, baseFields, '', message, fields) },
    error(message, fields) { emit('error', component, baseFields, '', message, fields) },
    event(name, fields) { emit('info', component, baseFields, 'event', name, fields) },
    ui(name, fields) { emit('info', component, baseFields, 'ui', name, fields) },
  }
}

/** Create a component-scoped logger, e.g. createLogger('pty-session'). */
export function createLogger(component: string): RemoteLogger {
  return makeLogger(component, {})
}
