import fs from 'node:fs/promises'
import { createLogger } from '../../log'
import { devTrace } from '../devlog'
import { cwdFromPrefix, defaultRoots, type Harness, type SessionRoots } from './locate'

/**
 * THE ROUTER'S LEFTOVERS ARE SWEPT UP, NOT KEPT FOREVER.
 *
 * Every spoken command is classified by a router run — `headless-router-engine`
 * or `codex-exec-router-engine` — and each one writes a full provider
 * transcript to ~/.claude/projects or ~/.codex/sessions. "ONE EXEC PER ROUTE,
 * deliberately", as the Codex router puts it: nothing ever resumes one.
 *
 * On one real machine that was 684 transcripts of a person's own sentences
 * quoted back inside a classification prompt. They are excluded from the index
 * now (see MACHINERY in turn-index.ts), which fixes retrieval — but they still
 * accumulate on disk in the user's Claude and Codex history, where the person
 * never asked for them and cannot tell them apart from their own work.
 *
 * WHAT THIS DOES NOT TOUCH, and why:
 *  - unmute-agent/runtime — the Agent's own chat, RESUMED across turns.
 *    Deleting it would erase the conversation the person is looking at.
 *  - anything whose cwd is not a router directory. The rule is the cwd and
 *    nothing else: never a filename, never a size, never "it looks generated".
 *  - anything newer than the grace window, so a live or just-finished routing
 *    run is never pulled out from under itself.
 *
 * Failures are per file and never throw: a sweep that cannot delete something
 * leaves it for the next pass.
 */

const log = createLogger('router-sweep')

/** Only these. A directory Unmute did not spawn for routing is not ours. */
const ROUTER_DIR = /[\\/]\.unmute[\\/]remote[\\/]router-[A-Za-z0-9-]+/
/** Old enough that nothing is still writing to it. */
export const ROUTER_GRACE_MS = 24 * 60 * 60 * 1_000
/** Enough of a transcript to carry its cwd, the same prefix the index reads. */
const PREFIX_BYTES = 64 * 1024
/** A sweep is bounded work: the rest waits for the next one. */
const MAX_PER_SWEEP = 2_000

export interface RouterSweepResult {
  scanned: number
  deleted: number
  bytes: number
  failed: number
}

export interface RouterSweepDeps {
  roots?: SessionRoots
  now?: () => number
  graceMs?: number
  /** Report only: say what would go, delete nothing. */
  dryRun?: boolean
}

async function transcripts(dir: string, depth = 0): Promise<string[]> {
  if (depth > 8) return []
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
  try { entries = await fs.readdir(dir, { withFileTypes: true }) as any } catch { return [] }
  const found: string[] = []
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`
    if (entry.isDirectory()) found.push(...await transcripts(full, depth + 1))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full)
  }
  return found
}

/** The cwd a transcript records, from its own first bytes. */
async function cwdOf(path: string): Promise<string | undefined> {
  const handle = await fs.open(path, 'r').catch(() => null)
  if (!handle) return undefined
  try {
    const buffer = Buffer.alloc(PREFIX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, PREFIX_BYTES, 0)
    return cwdFromPrefix(buffer.subarray(0, bytesRead).toString('utf8'))
  } catch { return undefined }
  finally { await handle.close().catch(() => {}) }
}

export async function sweepRouterSessions(deps: RouterSweepDeps = {}): Promise<RouterSweepResult> {
  const roots = deps.roots ?? defaultRoots()
  const now = (deps.now ?? Date.now)()
  const grace = deps.graceMs ?? ROUTER_GRACE_MS
  const result: RouterSweepResult = { scanned: 0, deleted: 0, bytes: 0, failed: 0 }

  for (const dir of [roots.claudeProjects, roots.codexSessions] as const) {
    for (const path of await transcripts(dir)) {
      if (result.deleted >= MAX_PER_SWEEP) break
      const stat = await fs.stat(path).catch(() => null)
      if (!stat?.isFile()) continue
      // Age first: it is one stat, and it rules out almost everything before
      // any file is opened.
      if (now - stat.mtimeMs < grace) continue
      result.scanned++
      const cwd = await cwdOf(path)
      if (!ROUTER_DIR.test(cwd ?? '')) continue
      if (deps.dryRun) { result.deleted++; result.bytes += stat.size; continue }
      try {
        await fs.rm(path)
        result.deleted++
        result.bytes += stat.size
      } catch { result.failed++ }
    }
  }

  if (result.deleted || result.failed) {
    log.event('router-sweep', { ...result, dryRun: !!deps.dryRun, graceHours: Math.round(grace / 3_600_000) })
  }
  devTrace('router-sweep', { ...result, dryRun: !!deps.dryRun })
  return result
}

/** Harness type is re-exported so a caller can scope a sweep in a test. */
export type { Harness }
