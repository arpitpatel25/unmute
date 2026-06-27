// recipe-store.ts
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createLogger } from './log.ts'

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

export function serializeRecipe(r: Pick<Recipe, 'frontmatter' | 'body'>): string {
  const lines = FM_ORDER.map((k) => `${k}: ${r.frontmatter[k]}`)
  return `---\n${lines.join('\n')}\n---\n\n${r.body.replace(/^\n+/, '')}`
}
