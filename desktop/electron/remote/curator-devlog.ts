// Unmute Remote — the Skill Curator's DEV-ONLY diagnostics logger.
//
// Purpose: let a developer running a dev/test build reconstruct the ENTIRE
// curator experience — every engine decision + its reasoning, and every user
// interaction — from log files alone, without the tester narrating anything.
//
// PRIVACY: these logs contain the user's raw session transcripts + model
// reasoning. This layer MUST stay OFF in the public/packaged build. The single
// source of truth is devLogEnabled() (fail-safe-off): init.ts auto-enables it for
// UNPACKAGED dev runs only; a packaged public build never sets the env var (a dev
// can still opt in by exporting UNMUTE_CURATOR_DEVLOG=1 explicitly).
//
// Contract: when disabled, devlog/devlogDump return IMMEDIATELY — no file, no
// dir, zero behavior change. Nothing logged here is ever read back into a
// decision; this layer cannot change what the curator does. Every write is
// best-effort: errors are swallowed so logging can NEVER throw into the engine.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { curatorPaths } from './curator-store'

/** Single gate. Fail-safe-off: only '1' enables. */
export function devLogEnabled(): boolean {
  return process.env.UNMUTE_CURATOR_DEVLOG === '1'
}

// Serialize every append/dump through one module-level promise chain so JSON
// lines never interleave (mirrors the store's write-chain discipline). The chain
// never rejects: each step swallows its own errors.
let chain: Promise<unknown> = Promise.resolve()

/** Append one JSON line to logs/events.jsonl. Correlate entries with ids when
 *  known (sweepId / proposalId / taskId) plus a `stage` + `kind` so the log
 *  replays as a timeline. No-op (and no file/dir) when the gate is off. */
export function devlog(entry: Record<string, unknown>): void {
  if (!devLogEnabled()) return
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`
  chain = chain.then(async () => {
    try {
      const p = curatorPaths()
      await fs.mkdir(p.logsDir, { recursive: true })
      await fs.appendFile(join(p.logsDir, 'events.jsonl'), line)
    } catch { /* best-effort — logging must never throw into the engine */ }
  })
}

/** Write a pretty JSON file logs/<name>.json — for big per-sweep reasoning dumps
 *  (the full inputs the model saw + its raw output). No-op when the gate is off. */
export function devlogDump(name: string, data: unknown): void {
  if (!devLogEnabled()) return
  chain = chain.then(async () => {
    try {
      const p = curatorPaths()
      await fs.mkdir(p.logsDir, { recursive: true })
      await fs.writeFile(join(p.logsDir, `${name}.json`), JSON.stringify(data, null, 2))
    } catch { /* best-effort */ }
  })
}
