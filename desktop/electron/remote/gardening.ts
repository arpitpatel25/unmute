import { promises as fs } from 'node:fs'
import { createLogger } from './log'
import { listRecipes, isStaleHigh, type Recipe } from './recipe-store'

const log = createLogger('gardening')

export interface GardenAction { kind: 'prune' | 'stale-flag' | 'dedupe'; name: string; surface: string; reason: string }

export async function planGardening(opts: { baseDir?: string; nowMs: number; pruneContradictedRatio?: number; idleMs?: number }): Promise<GardenAction[]> {
  const minContradictions = 2
  const recipes = await listRecipes({ baseDir: opts.baseDir })
  const actions: GardenAction[] = []
  // 1. prune nursery recipes that keep failing (contradicted >= N, no confirmations).
  for (const r of recipes) {
    const { name, surface, runs_confirmed, runs_contradicted, confidence } = r.frontmatter
    if (confidence !== 'high' && runs_contradicted >= minContradictions && runs_confirmed === 0) {
      actions.push({ kind: 'prune', name, surface, reason: `contradicted ${runs_contradicted}x, never confirmed` })
    }
  }
  // 2. flag stale-high (informational; injection already hedges them).
  for (const r of recipes) {
    if (isStaleHigh(r, opts.nowMs)) actions.push({ kind: 'stale-flag', name: r.frontmatter.name, surface: r.frontmatter.surface, reason: 'high but unverified past window' })
  }
  // (dedupe across overlapping descriptions: deferred to a librarian-assisted pass;
  //  not auto-destructive here — see plan §Deferred.)
  // TEMP(memory-debug): remove after calibration
  log.event('gardening-planned', { MEMORY_DEBUG: true, count: actions.length })
  return actions
}

export async function applyGardening(actions: GardenAction[], opts: { baseDir?: string }): Promise<void> {
  const recipes = await listRecipes({ baseDir: opts.baseDir })
  const byName = new Map(recipes.map((r) => [r.frontmatter.name, r]))
  for (const a of actions) {
    if (a.kind !== 'prune') continue // stale-flag is informational; dedupe deferred
    const r = byName.get(a.name)
    if (!r?.path) continue
    try {
      await fs.rm(r.path, { force: true })
      // TEMP(memory-debug): remove after calibration
      log.event('gardening-pruned', { MEMORY_DEBUG: true, name: a.name, reason: a.reason })
    }
    catch (e) { log.warn('gardening prune failed', { name: a.name, error: (e as Error).message }) }
  }
}
