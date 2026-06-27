// recipe-store.ts
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createLogger } from './log'

const log = createLogger('recipe-store')

export type Confidence = 'low' | 'medium' | 'high'
export type Tier = 'nursery' | 'skill'

export interface RecipeFrontmatter {
  name: string
  surface: string
  description: string
  confidence: Confidence
  runs_confirmed: number
  runs_contradicted: number
  created: string
  last_used: string
  last_verified: string
}

export interface Recipe {
  frontmatter: RecipeFrontmatter
  body: string
  path: string
}

const NUM_FIELDS = new Set(['runs_confirmed', 'runs_contradicted'])

/** Parse a single-line-scalar frontmatter block + markdown body. Returns null
 *  if the leading `---` fenced frontmatter is absent/!malformed (tolerant). */
export function parseRecipe(text: string, path: string): Recipe | null {
  if (!text.startsWith('---')) {
    // TEMP(memory-debug): remove after calibration
    log.event('parse-recipe.no-frontmatter', { MEMORY_DEBUG: true, path, reason: 'text does not start with ---' })
    return null
  }
  const end = text.indexOf('\n---', 3)
  if (end === -1) {
    // TEMP(memory-debug): remove after calibration
    log.event('parse-recipe.no-frontmatter-close', { MEMORY_DEBUG: true, path, reason: 'closing --- not found' })
    return null
  }
  const fmBlock = text.slice(3, end).trim()
  const body = text.slice(text.indexOf('\n', end + 1) + 1)
  const fm: Record<string, unknown> = {}
  for (const line of fmBlock.split('\n')) {
    const i = line.indexOf(':')
    if (i === -1) continue
    const key = line.slice(0, i).trim()
    let val: string | number = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (NUM_FIELDS.has(key)) val = Number(val) || 0
    fm[key] = val
  }
  if (typeof fm.name !== 'string' || !fm.name) {
    // TEMP(memory-debug): remove after calibration
    log.event('parse-recipe.missing-name', { MEMORY_DEBUG: true, path, reason: 'name field absent or empty' })
    return null
  }
  const conf = (fm.confidence === 'medium' || fm.confidence === 'high') ? fm.confidence : 'low'
  return {
    frontmatter: {
      name: String(fm.name),
      surface: String(fm.surface ?? 'general'),
      description: String(fm.description ?? ''),
      confidence: conf,
      runs_confirmed: Number(fm.runs_confirmed ?? 0),
      runs_contradicted: Number(fm.runs_contradicted ?? 0),
      created: String(fm.created ?? ''),
      last_used: String(fm.last_used ?? ''),
      last_verified: String(fm.last_verified ?? ''),
    },
    body,
    path,
  }
}

const FM_ORDER: Array<keyof RecipeFrontmatter> = [
  'name', 'surface', 'description', 'confidence',
  'runs_confirmed', 'runs_contradicted', 'created', 'last_used', 'last_verified',
]

/** Frontmatter is single-line scalars only (dependency-free parsing). A stray
 *  newline in a string scalar (e.g. a write-mode librarian-authored description)
 *  would corrupt the block, so collapse interior whitespace on serialize. */
function scalar(v: string | number): string {
  return typeof v === 'number' ? String(v) : String(v).replace(/\s+/g, ' ').trim()
}

export function serializeRecipe(r: Pick<Recipe, 'frontmatter' | 'body'>): string {
  const lines = FM_ORDER.map((k) => `${k}: ${scalar(r.frontmatter[k])}`)
  return `---\n${lines.join('\n')}\n---\n\n${r.body.replace(/^\n+/, '')}`
}

// ── Task 2: tier↔folder mapping, paths, list/read/write ──────────────────────

export function memoryRoot(baseDir?: string): string {
  return baseDir ?? join(homedir(), '.unmute', 'remote')
}
export function recipesDir(baseDir?: string): string { return join(memoryRoot(baseDir), 'recipes') }
export function graduatedDir(baseDir?: string): string { return join(memoryRoot(baseDir), 'skills') }

export function tierForConfidence(c: Confidence): Tier { return c === 'high' ? 'skill' : 'nursery' }

export function dirForRecipe(fm: Pick<RecipeFrontmatter, 'confidence' | 'surface'>, baseDir?: string): string {
  const root = tierForConfidence(fm.confidence) === 'skill' ? graduatedDir(baseDir) : recipesDir(baseDir)
  return join(root, fm.surface || 'general')
}

export function fileNameFor(name: string): string {
  return /\.md$/.test(name) ? name : `${name}.md`
}

async function readRecipeDir(root: string): Promise<Recipe[]> {
  let surfaces: string[]
  try { surfaces = await fs.readdir(root) } catch { return [] }
  const out: Recipe[] = []
  for (const surface of surfaces) {
    const sdir = join(root, surface)
    let files: string[]
    try { files = await fs.readdir(sdir) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      const p = join(sdir, f)
      try {
        const r = parseRecipe(await fs.readFile(p, 'utf8'), p)
        if (r) out.push(r)
      } catch { /* unreadable — skip */ }
    }
  }
  return out
}

export async function listRecipes(opts: { tier?: Tier; surface?: string; baseDir?: string } = {}): Promise<Recipe[]> {
  const roots = opts.tier === 'nursery' ? [recipesDir(opts.baseDir)]
    : opts.tier === 'skill' ? [graduatedDir(opts.baseDir)]
      : [recipesDir(opts.baseDir), graduatedDir(opts.baseDir)]
  let all: Recipe[] = []
  for (const root of roots) all = all.concat(await readRecipeDir(root))
  const result = opts.surface ? all.filter((r) => r.frontmatter.surface === opts.surface) : all
  // TEMP(memory-debug): remove after calibration
  log.event('list-recipes', { MEMORY_DEBUG: true, tier: opts.tier ?? 'all', surface: opts.surface ?? 'all', count: result.length })
  return result
}

export async function readNurseryRecipes(surface: string, baseDir?: string): Promise<Recipe[]> {
  return listRecipes({ tier: 'nursery', surface, baseDir })
}

/** Atomic write into the tier+surface folder. Returns the absolute path. */
export async function writeRecipe(r: Pick<Recipe, 'frontmatter' | 'body'>, baseDir?: string): Promise<string> {
  const dir = dirForRecipe(r.frontmatter, baseDir)
  await fs.mkdir(dir, { recursive: true })
  const dest = join(dir, fileNameFor(r.frontmatter.name))
  const tmp = `${dest}.tmp`
  await fs.writeFile(tmp, serializeRecipe(r), 'utf8')
  await fs.rename(tmp, dest)
  // TEMP(memory-debug): remove after calibration
  log.event('recipe-written', { MEMORY_DEBUG: true, name: r.frontmatter.name, confidence: r.frontmatter.confidence, surface: r.frontmatter.surface, dest })
  return dest
}

// ── Task 3: promote/demote (move) + freshness predicate ──────────────────────

export const FRESHNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export async function moveRecipe(r: Recipe, toConfidence: Confidence, baseDir?: string): Promise<Recipe> {
  const next: Recipe = { ...r, frontmatter: { ...r.frontmatter, confidence: toConfidence } }
  const newPath = await writeRecipe(next, baseDir)
  if (r.path && r.path !== newPath) {
    try { await fs.rm(r.path, { force: true }) } catch { /* best-effort */ }
  }
  // TEMP(memory-debug): remove after calibration
  log.event('recipe-moved', { MEMORY_DEBUG: true, name: r.frontmatter.name, from: r.frontmatter.confidence, to: toConfidence })
  return { ...next, path: newPath }
}

export function isStaleHigh(r: Recipe, nowMs: number, windowMs = FRESHNESS_WINDOW_MS): boolean {
  if (r.frontmatter.confidence !== 'high') return false
  const t = Date.parse(r.frontmatter.last_verified)
  if (Number.isNaN(t)) return true // high but never verified -> treat as stale
  return nowMs - t > windowMs
}
