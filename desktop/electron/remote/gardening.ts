import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from './log'
import { listRecipes, isStaleHigh, moveRecipe, recipesDir, graduatedDir, type Confidence, type Recipe, type RecipeFrontmatter } from './recipe-store'
import { userProfilePath } from './skills'
import { devEvent } from './curator-devlog'

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
  devEvent(log, 'gardening-planned', { count: actions.length })
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
      devEvent(log, 'gardening-pruned', { name: a.name, reason: a.reason })
    }
    catch (e) { log.warn('gardening prune failed', { name: a.name, error: (e as Error).message }) }
  }
}

// ── On-demand cleanup (user-triggered; deterministic, no LLM) ──────────────────
// Storage is cheap, so this is OPT-IN: the UI shows usage and the user presses a
// button. It does the deterministic gardening — exact-name dedup, prune of proven
// junk, LRU eviction of stale never-confirmed leads, and retiring stale-high to
// medium. Semantic (meaning-based) dedup is deferred to a future librarian pass.

export const IDLE_EVICT_MS = 45 * 86_400_000 // a low lead unused this long, never confirmed → evict
const CONF_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 }
// Most recent activity timestamp, or 0 when the recipe carries NO parseable date.
// 0 means "unknown" — eviction must never fire on it (a freshly-written recipe
// that hasn't been dated yet must not read as infinitely stale).
const activityMs = (f: RecipeFrontmatter): number =>
  Math.max(Date.parse(f.last_used) || 0, Date.parse(f.last_verified) || 0, Date.parse(f.created) || 0)

export interface CleanupResult { pruned: string[]; evicted: string[]; demoted: string[]; deduped: string[] }

export async function cleanupMemory(opts: { baseDir?: string; nowMs: number; idleEvictMs?: number }): Promise<CleanupResult> {
  const idleMs = opts.idleEvictMs ?? IDLE_EVICT_MS
  // Tier matters: prune/evict are NURSERY-only. A graduated skill must NEVER be
  // deleted by the low-confidence rules — skills can lack confidence frontmatter
  // (which parses as 'low'), and deleting them would destroy real learned memory.
  const nursery = await listRecipes({ tier: 'nursery', baseDir: opts.baseDir })
  const skills = await listRecipes({ tier: 'skill', baseDir: opts.baseDir })
  const res: CleanupResult = { pruned: [], evicted: [], demoted: [], deduped: [] }
  const toDelete = new Set<string>()        // paths slated for removal
  const dedupLosers = new Set<string>()     // exclude from prune/evict double-counting

  // 1. Exact-name dedup across both tiers — keep the best per name. A graduated
  //    skill always beats a nursery copy of the same name; then confidence, then
  //    recency.
  const tierRank = (r: Recipe): number => (skills.includes(r) ? 1 : 0)
  const byName = new Map<string, Recipe[]>()
  for (const r of [...skills, ...nursery]) {
    const g = byName.get(r.frontmatter.name) ?? []
    g.push(r); byName.set(r.frontmatter.name, g)
  }
  for (const [name, group] of byName) {
    if (group.length < 2) continue
    const sorted = [...group].sort((a, b) =>
      tierRank(b) - tierRank(a)
      || CONF_RANK[b.frontmatter.confidence] - CONF_RANK[a.frontmatter.confidence]
      || activityMs(b.frontmatter) - activityMs(a.frontmatter))
    for (const loser of sorted.slice(1)) if (loser.path) { toDelete.add(loser.path); dedupLosers.add(loser.path) }
    res.deduped.push(name)
  }

  // 2. Prune proven junk + 3. LRU-evict stale never-confirmed leads — NURSERY only.
  for (const r of nursery) {
    if (r.path && dedupLosers.has(r.path)) continue
    const f = r.frontmatter
    if (f.runs_contradicted >= 2 && f.runs_confirmed === 0) {
      if (r.path) { toDelete.add(r.path); res.pruned.push(f.name) }
      continue
    }
    const am = activityMs(f)
    // am > 0 guard: never evict a recipe with no real date (unknown ≠ stale).
    if (f.confidence === 'low' && f.runs_confirmed === 0 && am > 0 && opts.nowMs - am > idleMs) {
      if (r.path) { toDelete.add(r.path); res.evicted.push(f.name) }
    }
  }

  for (const p of toDelete) {
    try { await fs.rm(p, { force: true }) }
    catch (e) { log.warn('cleanup delete failed', { path: p, error: (e as Error).message }) }
  }

  // 4. Retire stale-high → demote to medium (graduated skills only; isStaleHigh
  //    already requires confidence === 'high', so undated flat skills are untouched).
  for (const r of skills) {
    if (r.path && toDelete.has(r.path)) continue
    if (isStaleHigh(r, opts.nowMs)) {
      try { await moveRecipe(r, 'medium', opts.baseDir); res.demoted.push(r.frontmatter.name) }
      catch (e) { log.warn('cleanup demote failed', { name: r.frontmatter.name, error: (e as Error).message }) }
    }
  }
  devEvent(log, 'cleanup-memory', { pruned: res.pruned.length, evicted: res.evicted.length, demoted: res.demoted.length, deduped: res.deduped.length })
  return res
}

/** Total on-disk footprint of the memory store (recipes + skills + profile) plus
 *  recipe/skill counts — what the UI shows so the user can decide to clean up. */
export async function memoryUsage(opts: { baseDir?: string }): Promise<{ bytes: number; recipeCount: number; skillCount: number }> {
  let bytes = 0
  const walk = async (dir: string): Promise<void> => {
    let ents
    try { ents = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else { try { bytes += (await fs.stat(p)).size } catch { /* vanished mid-scan */ } }
    }
  }
  await walk(recipesDir(opts.baseDir))
  await walk(graduatedDir(opts.baseDir))
  try { bytes += (await fs.stat(userProfilePath(opts.baseDir))).size } catch { /* no profile yet */ }
  const recipeCount = (await listRecipes({ tier: 'nursery', baseDir: opts.baseDir })).length
  const skillCount = (await listRecipes({ tier: 'skill', baseDir: opts.baseDir })).length
  return { bytes, recipeCount, skillCount }
}
