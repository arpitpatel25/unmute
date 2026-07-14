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

const KEEP_DAYS = 7
const FILE_RE = /^dictation-(\d{4})-(\d{2})-(\d{2})\.jsonl$/

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
