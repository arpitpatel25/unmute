// desktop/engine-overrides/electron/notetaker/notetakerLog.ts
//
// Structured logging for the meeting notetaker, built to answer one
// question after any real test run: "from the point the user triggered
// note-taking to the end, what actually happened, and where (if anywhere)
// did it go wrong?" — which app/tab was detected or targeted, which audio
// source(s) actually produced chunks, every chunk's cut/encode/transcribe/
// write outcome, and every persistence and IPC step.
//
// WHY NOT desktop/electron/remote/log.ts (the existing structured logger,
// already used by notetakerWidget.ts): that file lives in the closed-source
// electron/remote/ tree. notetakerInit.ts's own file header documents in
// detail why a file in engine-overrides/electron/ (the OSS engine tree)
// cannot statically import from electron/remote/ — the opaque-dependency
// design of init.ts plus wire-into-engine.sh's copy-time directory layout
// make such an import unresolvable both locally and post-copy (verified by
// trying it: tsc throws TS2307). This module is a deliberately small,
// self-contained duplicate of that file's console+file dual-sink design
// (same line format, same truncation-for-safety idea) rather than a shared
// dependency, so the two trees never need to resolve into each other.
//
// Usage:
//   import { createNotetakerLogger } from './notetakerLog'
//   const log = createNotetakerLogger('init')
//   const mlog = log.child({ meetingId })   // correlate to one meeting
//   mlog.event('capture-started', { targetApp, targetPid })

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export type NotetakerLogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<NotetakerLogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

// One file per app launch, so a whole test run's narrative lives in one
// place a user or a later debugging session can just `tail -f`.
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-')
let logDir: string | null = null
let logFilePath: string | null = null
let fileWriteFailed = false

function ensureLogFile(): string | null {
  if (logFilePath || fileWriteFailed) return logFilePath
  try {
    const dir = join(app.getPath('userData'), 'notetaker-logs')
    mkdirSync(dir, { recursive: true })
    logDir = dir
    logFilePath = join(dir, `notetaker-${RUN_ID}.log`)
    appendFileSync(logFilePath, `\n==== notetaker log, run ${RUN_ID} @ ${new Date().toISOString()} ====\n`)
    pruneOldLogs(dir)
  } catch (e) {
    // Never let logging setup break the feature it's trying to observe.
    fileWriteFailed = true
    console.error('[notetaker:log] could not open log file, console-only for this run:', (e as Error).message)
  }
  return logFilePath
}

/** Keeps at most this many run-log files around — a dev-test build gets
 *  relaunched a lot, and nothing here ever deletes anything on its own. */
const MAX_LOG_FILES = 20

function pruneOldLogs(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('notetaker-') && f.endsWith('.log'))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const { f } of files.slice(MAX_LOG_FILES)) {
      try { unlinkSync(join(dir, f)) } catch { /* best effort */ }
    }
  } catch { /* best effort — never block logging on cleanup */ }
}

/** Where this run's log file is (or will be, once something logs), for
 *  surfacing in the UI ("reveal logs") or telling a tester where to look. */
export function getNotetakerLogFilePath(): string | null {
  return logFilePath ?? ensureLogFile()
}

export function getNotetakerLogDir(): string | null {
  return logDir
}

function truncate(value: string, max = 500): string {
  return value.length > max ? value.slice(0, max) + `…<truncated ${value.length - max} chars>` : value
}

function serializeFields(fields?: Record<string, unknown>): string {
  if (!fields || Object.keys(fields).length === 0) return ''
  try {
    const safe: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(fields)) {
      // Never let a full transcript/chunk-of-text blow up one log line —
      // truncated to enough to diagnose "was there real content here",
      // never a full user transcript in every line.
      safe[k] = typeof v === 'string' ? truncate(v) : v
    }
    return ' ' + JSON.stringify(safe)
  } catch {
    return ' {"_fields":"<unserializable>"}'
  }
}

function emit(
  level: NotetakerLogLevel,
  component: string,
  baseFields: Record<string, unknown>,
  kind: '' | 'event',
  message: string,
  fields?: Record<string, unknown>,
): void {
  const ts = new Date().toISOString()
  const meetingId = baseFields.meetingId !== undefined ? ` meeting=${baseFields.meetingId}` : ''
  const kindTag = kind ? ` ${kind}` : ''
  const merged = { ...baseFields, ...(fields || {}) }
  delete (merged as Record<string, unknown>).meetingId
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [notetaker:${component}]${meetingId}${kindTag} ${message}${serializeFields(merged)}`

  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  sink(line)

  const path = ensureLogFile()
  if (path) {
    try { appendFileSync(path, line + '\n') } catch { /* never throw from logging */ }
  }
}

export interface NotetakerLogger {
  /** Correlate all subsequent logs to one meeting/session. */
  child(fields: Record<string, unknown>): NotetakerLogger
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
  /** A machine-meaningful state transition or decision — cut a chunk,
   *  resolved a target app, wrote a DB row, swept expired audio, etc. */
  event(name: string, fields?: Record<string, unknown>): void
}

function makeLogger(component: string, baseFields: Record<string, unknown>): NotetakerLogger {
  return {
    child(fields) { return makeLogger(component, { ...baseFields, ...fields }) },
    debug(message, fields) { emit('debug', component, baseFields, '', message, fields) },
    info(message, fields) { emit('info', component, baseFields, '', message, fields) },
    warn(message, fields) { emit('warn', component, baseFields, '', message, fields) },
    error(message, fields) { emit('error', component, baseFields, '', message, fields) },
    event(name, fields) { emit('info', component, baseFields, 'event', name, fields) },
  }
}

/** Create a component-scoped logger, e.g. createNotetakerLogger('init'). */
export function createNotetakerLogger(component: string): NotetakerLogger {
  return makeLogger(component, {})
}
