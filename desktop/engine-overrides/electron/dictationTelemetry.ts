// Persisted dictation telemetry — JSONL lines under <userData>/telemetry/.
//
// WHY: the 2026-07-14 accuracy investigation found the production build
// persists NOTHING about how a dictation was actually served (which engine,
// which cut reason, what latency). The console lines vanish with the window.
// One greppable line per event means a bad dictation in the field carries
// its own explanation. Pure helpers are unit-tested; fs writes are
// best-effort appends that must never break a dictation.

import fs from 'fs'
import path from 'path'

// ─── DEV BUILD FLAG ────────────────────────────────────────────────────
// PRODUCTION: false. When true (dev field builds only), the app tees EVERY
// console line (main + widget renderer) into dated console-*.log files and
// includes full transcript texts in telemetry events — never ship true:
// production machines must not persist what users say.
export const DEV_BUILD = true

const KEEP_DAYS = 7
const FILE_RE = /^(?:dictation|console)-(\d{4})-(\d{2})-(\d{2})\.(?:jsonl|log)$/

export function telemetryFileName(dayMs: number): string {
  const d = new Date(dayMs)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `dictation-${y}-${m}-${day}.jsonl`
}

export function telemetryLine(event: string, data: Record<string, unknown>, nowMs: number): string {
  try {
    return JSON.stringify({ ts: nowMs, event, ...data })
  } catch {
    return JSON.stringify({ ts: nowMs, event, unserializable: true })
  }
}

export function filesToPrune(names: string[], nowMs: number, keepDays: number = KEEP_DAYS): string[] {
  const cutoff = nowMs - keepDays * 24 * 60 * 60 * 1000
  return names.filter((n) => {
    const m = FILE_RE.exec(n)
    if (!m) return false
    const fileMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    return fileMs < cutoff
  })
}

let telemetryDir: string | null = null

/** Call once from main with app.getPath('userData')/telemetry. */
export function initTelemetry(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
    telemetryDir = dir
    for (const stale of filesToPrune(fs.readdirSync(dir), Date.now())) {
      try { fs.unlinkSync(path.join(dir, stale)) } catch { /* best-effort */ }
    }
  } catch (e) {
    console.warn('[telemetry] init failed:', e instanceof Error ? e.message : e)
    telemetryDir = null
  }
}

export function logTelemetry(event: string, data: Record<string, unknown>): void {
  if (!telemetryDir) return
  const now = Date.now()
  const line = telemetryLine(event, data, now)
  fs.appendFile(path.join(telemetryDir, telemetryFileName(now)), line + '\n', () => { /* best-effort */ })
}

// ─── DEV-BUILD console tee ─────────────────────────────────────────────
// Captures the ENTIRE console story of a session to disk: the main
// process's [session]/[paywall-stream] narration AND the widget
// renderer's [audio:*]/[widget:ux] lines (via the console-message event),
// which otherwise vanish with the window. Best-effort appends; a logging
// failure must never touch the dictation path.

function consoleFileName(dayMs: number): string {
  return telemetryFileName(dayMs).replace('dictation-', 'console-').replace('.jsonl', '.log')
}

function appendConsole(tag: string, text: string): void {
  if (!telemetryDir) return
  const now = Date.now()
  const stamp = new Date(now).toISOString()
  fs.appendFile(
    path.join(telemetryDir, consoleFileName(now)),
    `${stamp} ${tag} ${text}\n`,
    () => { /* best-effort */ },
  )
}

let mainTeeInstalled = false

/** DEV_BUILD only: patch main-process console.{log,warn,error} to also
 *  append to console-YYYY-MM-DD.log. Idempotent. */
export function installMainConsoleTee(): void {
  if (!DEV_BUILD || mainTeeInstalled) return
  mainTeeInstalled = true
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      try {
        const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
        appendConsole(`[main:${level}]`, text)
      } catch { /* never break logging */ }
    }
  }
}

const rendererTeed = new WeakSet<object>()

/** DEV_BUILD only: tee a renderer webContents' console into the same file.
 *  Handles both the legacy (level, message, line, source) signature and the
 *  Electron ≥30 event-object shape. Safe to call repeatedly per window. */
export function attachRendererConsoleTee(webContents: unknown): void {
  if (!DEV_BUILD || !webContents || typeof webContents !== 'object') return
  if (rendererTeed.has(webContents)) return
  const wc = webContents as { on?: (ev: string, cb: (...a: unknown[]) => void) => void }
  if (typeof wc.on !== 'function') return
  rendererTeed.add(webContents)
  try {
    wc.on('console-message', (first: unknown, ...rest: unknown[]) => {
      try {
        const evt = first as { message?: unknown; level?: unknown }
        const message = typeof evt?.message === 'string' ? evt.message : String(rest[1] ?? '')
        const level = typeof evt?.level === 'string' || typeof evt?.level === 'number' ? String(evt.level) : String(rest[0] ?? 'log')
        appendConsole(`[renderer:${level}]`, message)
      } catch { /* never break logging */ }
    })
  } catch { /* best-effort */ }
}
