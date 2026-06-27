# Unmute Memory System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat shared-skills memory with a confidence-graduated memory system (nursery `recipes/` + graduated `skills/`, per-surface), where a librarian moves confidence by comparing each injected recipe against a reduced JSONL trace of what the executor actually did — end-to-end, including managed/raw session modes, freshness, and gardening.

**Architecture:** Additive layering on the existing remote stack. A new `recipe-store.ts` owns the confidence-aware store (frontmatter schema, tier↔folder mapping, promote/demote = file move). Dispatch gains surface detection + hedged nursery injection. A new `trace-reducer.ts` resolves and distills the executor's `~/.claude/projects/.../*.jsonl`. The existing `librarian.ts` gets a new constitution + the reduced trace + a write-gate (read-only by default). The router emits surface + mode. Freshness and gardening ride on top. Nothing touches the status wire protocol, billing path, or overlay.

**Tech Stack:** TypeScript (Node ESM, `.ts` imports), `node:test` + `node:assert/strict` run via `node --import tsx --test`, `node:fs`/`node:path`/`node:os`, `electron-store` (settings), no new dependencies.

## Global Constraints

- **Test command:** `cd desktop && node --import tsx --test electron/remote/<file>.test.ts` (single file) or `npm test` (all). Tests are co-located `*.test.ts`; import local modules with explicit `.ts` extension.
- **Memory root stays `~/.unmute/remote/`.** Do NOT move it to `~/.claude/`. Auto-fire is achieved by copying graduated skills into each task's `cwd/.claude/skills/` (existing mechanism), never by living in `~/.claude/skills/`.
- **Only the librarian writes** the store. It is serialized, fire-and-forget, off the user's critical path. Never block a task's `done` on curation.
- **New knowledge is born low-confidence in `recipes/` (nursery), never in `skills/`.** Down fast (one proven hard-fact contradiction → demote one tier), up slow (low→med 2 confirmations, med→high 3 + fresh).
- **Capture exploration, never reasoning.** Only `Invariants` / `Definition of done` / named structural facts are eligible to be stored as fact and to move confidence; `Defaults`/`Procedure` are adaptable and never move confidence.
- **Write-gate default OFF.** The librarian runs read-only (emits a `proposal.json`, mutates nothing) until `LIBRARIAN_WRITE_ENABLED` is turned on. This is the "earns the pen last" calibration phase, shipped as a switch — not unbuilt code.
- **Billing guard preserved:** never pass `--no-session-persistence`/`persistSession:false`, never set `CLAUDE_CODE_SKIP_PROMPT_HISTORY` (the executor's JSONL must persist), and keep `ANTHROPIC_*` env stripping on every spawn.
- **Clean slate (OD-1):** do not read or migrate any existing `~/.unmute/remote/skills/*.md`. `recipes/` and `skills/` start empty.
- **Frontmatter is single-line scalars only** (dependency-free parsing) — no block scalars, no YAML lib.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` and contain no backticks.

**Source spec:** `desktop/docs/memory-system/01-substrate-and-confidence-delta.md` (read it; every task below traces to it).

---

## File Structure

**New files (all under `desktop/electron/remote/`):**
- `recipe-store.ts` — confidence-aware store: frontmatter types, parse/serialize, tier↔folder mapping, list/read, write, promote/demote (move), freshness predicate. + `recipe-store.test.ts`.
- `surface.ts` — deterministic surface detection from an intent string. + `surface.test.ts`.
- `trace-reducer.ts` — locate the executor's JSONL by taskId, distill to a compact markdown action trace. + `trace-reducer.test.ts` (+ a committed real-transcript fixture).
- `gardening.ts` — periodic dedupe/prune/stale-flag pass over the store. + `gardening.test.ts`.

**Modified files:**
- `dispatch-prompt.ts` — render a hedged nursery block.
- `skills.ts` — surface-scoped graduated copy; keep profile helpers.
- `task-manager.ts` — surface+mode on `Task`; nursery injection; `injectedRecipes`; librarian handoff on `done` and recipe-bearing `failed`; mode gating.
- `librarian.ts` — new inputs (`injectedRecipes`, `outcome`, reduced trace), new constitution prompt, write-gate via `proposal.json`.
- `router.ts` — `RouteDecision` gains `surface` + `mode`; prompt updated.
- `init.ts` — wire write-gate setting, mode plumbing through dispatch, schedule gardening.

**Phases (each an independently testable milestone, matching the build order):**
1. Substrate (recipe-store) · 2. Surface detection · 3. Injection · 4. Trace pipeline · 5. Librarian constitution + gate · 6. Trigger + mode plumbing · 7. Router surface+mode · 8. Freshness · 9. Gardening · 10. Wiring + manual end-to-end.

---

## Phase 1 — Substrate: `recipe-store.ts`

### Task 1: Recipe frontmatter schema, parse, serialize

**Files:**
- Create: `desktop/electron/remote/recipe-store.ts`
- Test: `desktop/electron/remote/recipe-store.test.ts`

**Interfaces:**
- Produces:
  - `type Confidence = 'low' | 'medium' | 'high'`
  - `type Tier = 'nursery' | 'skill'`
  - `interface RecipeFrontmatter { name: string; surface: string; description: string; confidence: Confidence; runs_confirmed: number; runs_contradicted: number; created: string; last_used: string; last_verified: string }`
  - `interface Recipe { frontmatter: RecipeFrontmatter; body: string; path: string }`
  - `function parseRecipe(text: string, path: string): Recipe | null`
  - `function serializeRecipe(r: Pick<Recipe,'frontmatter'|'body'>): string`

- [ ] **Step 1: Write the failing test**

```ts
// recipe-store.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRecipe, serializeRecipe } from './recipe-store.ts'

const SAMPLE = `---
name: gmail-inbox-sweep
surface: gmail
description: check my email for events; scan my inboxes
confidence: low
runs_confirmed: 0
runs_contradicted: 0
created: 2026-06-27T00:00:00Z
last_used: 2026-06-27T00:00:00Z
last_verified: 2026-06-27T00:00:00Z
---

## Invariants (hard — never skip)
- Enumerate ALL logged-in Gmail profiles and check every one.
`

test('parseRecipe reads frontmatter + body', () => {
  const r = parseRecipe(SAMPLE, '/tmp/x.md')
  assert.ok(r)
  assert.equal(r!.frontmatter.name, 'gmail-inbox-sweep')
  assert.equal(r!.frontmatter.surface, 'gmail')
  assert.equal(r!.frontmatter.confidence, 'low')
  assert.equal(r!.frontmatter.runs_confirmed, 0)
  assert.match(r!.body, /Enumerate ALL logged-in Gmail profiles/)
  assert.equal(r!.path, '/tmp/x.md')
})

test('parseRecipe returns null on missing frontmatter', () => {
  assert.equal(parseRecipe('no frontmatter here', '/tmp/y.md'), null)
})

test('serializeRecipe round-trips', () => {
  const r = parseRecipe(SAMPLE, '/tmp/x.md')!
  const again = parseRecipe(serializeRecipe(r), '/tmp/x.md')!
  assert.deepEqual(again.frontmatter, r.frontmatter)
  assert.equal(again.body.trim(), r.body.trim())
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test electron/remote/recipe-store.test.ts`
Expected: FAIL — cannot find module './recipe-store.ts' / parseRecipe is not a function.

- [ ] **Step 3: Write minimal implementation**

```ts
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
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
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
  if (typeof fm.name !== 'string' || !fm.name) return null
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test electron/remote/recipe-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/remote/recipe-store.ts desktop/electron/remote/recipe-store.test.ts
git commit -m "feat(memory): recipe frontmatter parse/serialize"
```

### Task 2: Tier↔folder mapping, paths, list/read/write

**Files:**
- Modify: `desktop/electron/remote/recipe-store.ts`
- Test: `desktop/electron/remote/recipe-store.test.ts`

**Interfaces:**
- Produces:
  - `function memoryRoot(baseDir?: string): string`
  - `function recipesDir(baseDir?: string): string` (nursery root)
  - `function graduatedDir(baseDir?: string): string` (skills root)
  - `function tierForConfidence(c: Confidence): Tier`
  - `function dirForRecipe(fm: Pick<RecipeFrontmatter,'confidence'|'surface'>, baseDir?: string): string`
  - `function fileNameFor(name: string): string`
  - `async function listRecipes(opts?: { tier?: Tier; surface?: string; baseDir?: string }): Promise<Recipe[]>`
  - `async function readNurseryRecipes(surface: string, baseDir?: string): Promise<Recipe[]>`
  - `async function writeRecipe(r: Pick<Recipe,'frontmatter'|'body'>, baseDir?: string): Promise<string>`

- [ ] **Step 1: Write the failing test**

```ts
// append to recipe-store.test.ts
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  tierForConfidence, dirForRecipe, listRecipes, readNurseryRecipes, writeRecipe, recipesDir, graduatedDir,
} from './recipe-store.ts'

async function tmpBase() { return fs.mkdtemp(path.join(os.tmpdir(), 'recipe-')) }
function fm(over = {}) {
  return { name: 'r', surface: 'gmail', description: 'd', confidence: 'low',
    runs_confirmed: 0, runs_contradicted: 0, created: '', last_used: '', last_verified: '', ...over } as any
}

test('tierForConfidence: high is skill, else nursery', () => {
  assert.equal(tierForConfidence('high'), 'skill')
  assert.equal(tierForConfidence('medium'), 'nursery')
  assert.equal(tierForConfidence('low'), 'nursery')
})

test('dirForRecipe routes by tier+surface', () => {
  const base = '/b'
  assert.equal(dirForRecipe(fm({ confidence: 'low' }), base), path.join(recipesDir(base), 'gmail'))
  assert.equal(dirForRecipe(fm({ confidence: 'high' }), base), path.join(graduatedDir(base), 'gmail'))
})

test('writeRecipe + listRecipes + readNurseryRecipes', async () => {
  const base = await tmpBase()
  await writeRecipe({ frontmatter: fm({ name: 'a', confidence: 'low' }), body: '## Invariants\n- x\n' }, base)
  await writeRecipe({ frontmatter: fm({ name: 'b', confidence: 'high' }), body: '## Invariants\n- y\n' }, base)
  const all = await listRecipes({ baseDir: base })
  assert.equal(all.length, 2)
  const nursery = await listRecipes({ tier: 'nursery', baseDir: base })
  assert.equal(nursery.length, 1)
  assert.equal(nursery[0].frontmatter.name, 'a')
  const gmailNursery = await readNurseryRecipes('gmail', base)
  assert.equal(gmailNursery.length, 1)
  assert.equal(gmailNursery[0].frontmatter.name, 'a')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test electron/remote/recipe-store.test.ts`
Expected: FAIL — `tierForConfidence` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to recipe-store.ts
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
  return opts.surface ? all.filter((r) => r.frontmatter.surface === opts.surface) : all
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
  log.event('recipe-written', { name: r.frontmatter.name, confidence: r.frontmatter.confidence, surface: r.frontmatter.surface })
  return dest
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test electron/remote/recipe-store.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/remote/recipe-store.ts desktop/electron/remote/recipe-store.test.ts
git commit -m "feat(memory): tier-folder mapping + list/read/write recipes"
```

### Task 3: Promote/demote (move) + freshness predicate

**Files:**
- Modify: `desktop/electron/remote/recipe-store.ts`
- Test: `desktop/electron/remote/recipe-store.test.ts`

**Interfaces:**
- Produces:
  - `async function moveRecipe(r: Recipe, toConfidence: Confidence, baseDir?: string): Promise<Recipe>` — rewrites frontmatter.confidence, writes to the new tier folder, deletes the old file if its path differs. Returns the new Recipe.
  - `function isStaleHigh(r: Recipe, nowMs: number, windowMs?: number): boolean` — true iff confidence high and `last_verified` older than window (default 30 days).
  - `const FRESHNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000`

- [ ] **Step 1: Write the failing test**

```ts
// append to recipe-store.test.ts
import { moveRecipe, isStaleHigh, FRESHNESS_WINDOW_MS, parseRecipe as _p } from './recipe-store.ts'

test('moveRecipe promotes nursery->skill and removes the old file', async () => {
  const base = await tmpBase()
  const p = await writeRecipe({ frontmatter: fm({ name: 'm', confidence: 'medium' }), body: '## Invariants\n- z\n' }, base)
  const r = parseRecipe(await fs.readFile(p, 'utf8'), p)!
  const moved = await moveRecipe(r, 'high', base)
  assert.equal(moved.frontmatter.confidence, 'high')
  assert.equal((await listRecipes({ tier: 'skill', baseDir: base })).length, 1)
  assert.equal((await listRecipes({ tier: 'nursery', baseDir: base })).length, 0)
  await assert.rejects(fs.access(p)) // old file gone
})

test('isStaleHigh: only high + past window', () => {
  const now = 1_000_000_000_000
  const fresh = { frontmatter: fm({ confidence: 'high', last_verified: new Date(now - 1000).toISOString() }), body: '', path: '' } as any
  const stale = { frontmatter: fm({ confidence: 'high', last_verified: new Date(now - FRESHNESS_WINDOW_MS - 1000).toISOString() }), body: '', path: '' } as any
  const lowOld = { frontmatter: fm({ confidence: 'low', last_verified: new Date(now - FRESHNESS_WINDOW_MS - 1000).toISOString() }), body: '', path: '' } as any
  assert.equal(isStaleHigh(fresh, now), false)
  assert.equal(isStaleHigh(stale, now), true)
  assert.equal(isStaleHigh(lowOld, now), false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test electron/remote/recipe-store.test.ts`
Expected: FAIL — `moveRecipe` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to recipe-store.ts
export const FRESHNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export async function moveRecipe(r: Recipe, toConfidence: Confidence, baseDir?: string): Promise<Recipe> {
  const next: Recipe = { ...r, frontmatter: { ...r.frontmatter, confidence: toConfidence } }
  const newPath = await writeRecipe(next, baseDir)
  if (r.path && r.path !== newPath) {
    try { await fs.rm(r.path, { force: true }) } catch { /* best-effort */ }
  }
  log.event('recipe-moved', { name: r.frontmatter.name, from: r.frontmatter.confidence, to: toConfidence })
  return { ...next, path: newPath }
}

export function isStaleHigh(r: Recipe, nowMs: number, windowMs = FRESHNESS_WINDOW_MS): boolean {
  if (r.frontmatter.confidence !== 'high') return false
  const t = Date.parse(r.frontmatter.last_verified)
  if (Number.isNaN(t)) return true // high but never verified -> treat as stale
  return nowMs - t > windowMs
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test electron/remote/recipe-store.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/remote/recipe-store.ts desktop/electron/remote/recipe-store.test.ts
git commit -m "feat(memory): promote/demote move + freshness predicate"
```

---

## Phase 2 — Surface detection: `surface.ts`

### Task 4: Deterministic surface detection

**Files:**
- Create: `desktop/electron/remote/surface.ts`
- Test: `desktop/electron/remote/surface.test.ts`

**Interfaces:**
- Produces:
  - `const GENERAL_SURFACE = 'general'`
  - `function detectSurface(intent: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// surface.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectSurface, GENERAL_SURFACE } from './surface.ts'

test('detects gmail', () => {
  assert.equal(detectSurface('check my email for events'), 'gmail')
  assert.equal(detectSurface('scan my inboxes'), 'gmail')
})
test('detects sheets / calendar / canva', () => {
  assert.equal(detectSurface('add it to the spreadsheet'), 'google-sheets')
  assert.equal(detectSurface('what meetings do I have'), 'google-calendar')
  assert.equal(detectSurface('open my latest canva design'), 'canva')
})
test('falls back to general', () => {
  assert.equal(detectSurface('refactor the auth module'), GENERAL_SURFACE)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test electron/remote/surface.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// surface.ts
// Cheap, deterministic surface prior used to scope memory injection BEFORE the
// router exists (Phase 7 lets the router emit a better surface). Surface = the
// app/tool a task operates on; it is the flat namespace recipes live under.
export const GENERAL_SURFACE = 'general'

// First match wins; order matters where keywords overlap (sheets before docs).
const SURFACE_KEYWORDS: Array<[string, string[]]> = [
  ['gmail', ['email', 'inbox', 'inboxes', 'gmail', 'mail']],
  ['google-calendar', ['calendar', 'meeting', 'meetings', 'schedule', 'event', 'events']],
  ['google-sheets', ['sheet', 'sheets', 'spreadsheet']],
  ['google-docs', ['google doc', 'google docs', 'document']],
  ['google-drive', ['drive', 'my files']],
  ['canva', ['canva', 'design']],
  ['youtube', ['youtube', 'video', 'channel']],
]

export function detectSurface(intent: string): string {
  const t = (intent || '').toLowerCase()
  for (const [surface, kws] of SURFACE_KEYWORDS) {
    if (kws.some((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t))) return surface
  }
  return GENERAL_SURFACE
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test electron/remote/surface.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/remote/surface.ts desktop/electron/remote/surface.test.ts
git commit -m "feat(memory): deterministic surface detection"
```

---

## Phase 3 — Injection

### Task 5: Hedged nursery block in `dispatch-prompt.ts`

**Files:**
- Modify: `desktop/electron/remote/dispatch-prompt.ts`
- Test: `desktop/electron/remote/dispatch-prompt.test.ts` (exists — append)

**Interfaces:**
- Consumes: `Confidence` from `recipe-store.ts`.
- Produces (extends `DispatchInput`): optional `nurseryRecipes?: Array<{ name: string; confidence: Confidence; body: string }>` and optional `staleNotes?: string[]`. `buildDispatch` renders them.

- [ ] **Step 1: Write the failing test**

```ts
// append to dispatch-prompt.test.ts
import { buildDispatch } from './dispatch-prompt.ts'

test('buildDispatch renders a hedged nursery block with confidence stance', () => {
  const out = buildDispatch({
    intent: 'scan my inboxes',
    statusPath: '/t/status.json',
    nurseryRecipes: [{ name: 'gmail-inbox-sweep', confidence: 'low', body: '## Invariants\n- check all profiles' }],
  })
  assert.match(out, /unverified lead/i)         // low-confidence stance
  assert.match(out, /derive independently/i)
  assert.match(out, /check all profiles/)        // body included
})

test('buildDispatch with no nursery recipes is unchanged (terse)', () => {
  const out = buildDispatch({ intent: 'do x', statusPath: '/t/status.json' })
  assert.match(out, /\[Unmute Remote task\]/)
  assert.doesNotMatch(out, /unverified lead/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test electron/remote/dispatch-prompt.test.ts`
Expected: FAIL — nursery block not rendered.

- [ ] **Step 3: Write minimal implementation**

```ts
// dispatch-prompt.ts — extend DispatchInput + buildDispatch
import type { Confidence } from './recipe-store.ts'

export interface DispatchInput {
  intent: string
  statusPath: string
  recipeScratchPath?: string
  /** Nursery (low/medium) leads to inject HEDGED — never auto-fired skills. */
  nurseryRecipes?: Array<{ name: string; confidence: Confidence; body: string }>
  /** One-line "confirm before relying" notes for stale-high graduated skills. */
  staleNotes?: string[]
}

const STANCE: Record<Confidence, string> = {
  low: 'Unverified lead from a past run — treat skeptically and derive independently if it fails',
  medium: 'Usually-right approach from past runs — confirm as you go',
  high: 'Established approach',
}

export function buildDispatch({ intent, statusPath, recipeScratchPath, nurseryRecipes, staleNotes }: DispatchInput): string {
  const lines = [
    `[Unmute Remote task]`,
    `Task: ${intent}`,
    `Status file (yours to update per the loaded Unmute contract): ${statusPath}`,
  ]
  if (recipeScratchPath) {
    lines.push(`Recipe-suggestion scratch file (write a suggestion here only if you learned a better/repeatable way): ${recipeScratchPath}`)
  }
  for (const note of staleNotes ?? []) lines.push(`Note: ${note}`)
  for (const r of nurseryRecipes ?? []) {
    lines.push('', `--- Memory lead (${STANCE[r.confidence]}): ${r.name} ---`, r.body.trim(), `--- end lead ---`)
  }
  lines.push(`Act now. Follow the Unmute status-file contract that is already loaded.`)
  const payload = lines.join('\n')
  log.event('dispatch-payload-built', { intent, statusPath, bytes: payload.length, nursery: (nurseryRecipes ?? []).length })
  return payload
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test electron/remote/dispatch-prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/remote/dispatch-prompt.ts desktop/electron/remote/dispatch-prompt.test.ts
git commit -m "feat(memory): hedged nursery injection in dispatch payload"
```

### Task 6: Surface-scoped graduated copy in `skills.ts`

**Files:**
- Modify: `desktop/electron/remote/skills.ts`
- Test: `desktop/electron/remote/skills.test.ts` (the librarian.test.ts covers the old behavior; add a new file)
- Create: `desktop/electron/remote/skills-surface.test.ts`

**Interfaces:**
- Produces: `async function installSkillsIntoCwd(cwd: string, opts?: { surface?: string; baseDir?: string }): Promise<number>` — copies graduated skills from `skills/<surface>/` AND `skills/general/` into `cwd/.claude/skills/`. (Signature change: second arg becomes an options object; update the one caller in `task-manager.ts` in Task 9.)

- [ ] **Step 1: Write the failing test**

```ts
// skills-surface.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installSkillsIntoCwd, sessionSkillsDir } from './skills.ts'
import { writeRecipe } from './recipe-store.ts'

const fm = (o = {}) => ({ name: 'r', surface: 'gmail', description: 'd', confidence: 'high',
  runs_confirmed: 0, runs_contradicted: 0, created: '', last_used: '', last_verified: '', ...o } as any)

test('installSkillsIntoCwd copies only the surface + general graduated skills', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sk-'))
  await writeRecipe({ frontmatter: fm({ name: 'gmail-x', surface: 'gmail', confidence: 'high' }), body: 'b' }, base)
  await writeRecipe({ frontmatter: fm({ name: 'gen-y', surface: 'general', confidence: 'high' }), body: 'b' }, base)
  await writeRecipe({ frontmatter: fm({ name: 'canva-z', surface: 'canva', confidence: 'high' }), body: 'b' }, base)
  const cwd = path.join(base, 'task1')
  const n = await installSkillsIntoCwd(cwd, { surface: 'gmail', baseDir: base })
  assert.equal(n, 2) // gmail + general, NOT canva
  const copied = await fs.readdir(sessionSkillsDir(cwd))
  assert.ok(copied.includes('gmail-x.md'))
  assert.ok(copied.includes('gen-y.md'))
  assert.ok(!copied.includes('canva-z.md'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test electron/remote/skills-surface.test.ts`
Expected: FAIL — copies all / wrong signature.

- [ ] **Step 3: Write minimal implementation**

```ts
// skills.ts — replace installSkillsIntoCwd; keep sessionSkillsDir + profile helpers as-is.
import { graduatedDir } from './recipe-store.ts'
import { GENERAL_SURFACE } from './surface.ts'

export async function installSkillsIntoCwd(cwd: string, opts: { surface?: string; baseDir?: string } = {}): Promise<number> {
  const dst = sessionSkillsDir(cwd)
  const surfaces = Array.from(new Set([opts.surface, GENERAL_SURFACE].filter(Boolean) as string[]))
  let copied = 0
  for (const surface of surfaces) {
    const src = join(graduatedDir(opts.baseDir), surface)
    let names: string[]
    try { names = await fs.readdir(src) } catch { continue }
    await fs.mkdir(dst, { recursive: true })
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      try { await fs.cp(join(src, name), join(dst, name), { recursive: true }); copied++ }
      catch (e) { log.warn('skill copy failed', { name, error: (e as Error).message }) }
    }
  }
  log.event('skills-installed-into-cwd', { cwd, surfaces, copied })
  return copied
}
```

Note: the old `sharedSkillsDir`/`skillsIndex`/`listSharedSkills` exports are now dead (librarian uses `recipe-store.listRecipes` in Phase 5). Leave them in place until Task 12 removes the librarian's use, then delete in Task 12 to keep each commit green. Keep `sessionSkillsDir`, `userProfilePath`, `readUserProfile`, `installProfileIntoCwd`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test electron/remote/skills-surface.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/remote/skills.ts desktop/electron/remote/skills-surface.test.ts
git commit -m "feat(memory): surface-scoped graduated skill copy"
```

---

## Phase 4 — Trace pipeline: `trace-reducer.ts`

> **IMPORTANT (honesty gate):** the exact JSONL record shape Claude Code writes must be confirmed against a REAL transcript, not assumed. Task 7 captures a real fixture first, then the parser is written against it. Do not fabricate the schema.

### Task 7: Capture a real transcript fixture + locate the JSONL

**Files:**
- Create: `desktop/electron/remote/fixtures/sample-transcript.jsonl` (captured, trimmed)
- Create: `desktop/electron/remote/trace-reducer.ts`
- Test: `desktop/electron/remote/trace-reducer.test.ts`

**Interfaces:**
- Produces:
  - `async function locateTranscript(taskCwd: string, opts?: { projectsDir?: string }): Promise<string | null>`

- [ ] **Step 1: Capture a real fixture (manual, one-time)**

Run a throwaway Claude Code session in a scratch dir and copy its transcript:
```bash
mkdir -p /tmp/uttest && cd /tmp/uttest
# run any tiny task in claude here (e.g. "list files") then exit
ls ~/.claude/projects/ | grep tmp-uttest   # find the encoded dir
cp "$(ls -t ~/.claude/projects/*tmp-uttest*/*.jsonl | head -1)" \
   /Users/zodpatel/tools/unmute/unmute-cloud/desktop/electron/remote/fixtures/sample-transcript.jsonl
```
Trim the fixture to ~20-40 representative lines (keep at least one `tool_use`, one `tool_result`, one assistant text, and the final turn). Inspect the JSON shape of a line:
```bash
head -1 desktop/electron/remote/fixtures/sample-transcript.jsonl | node -e "process.stdin.on('data',d=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
```
Record the real field names you observe (e.g. `type`, `message.role`, `message.content[].type`) — Task 8's parser is written against THESE, adjusting the selectors below to match.

- [ ] **Step 2: Write the failing test (locator)**

```ts
// trace-reducer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { locateTranscript } from './trace-reducer.ts'

test('locateTranscript finds the jsonl whose project dir encodes the taskId', async () => {
  const projects = await fs.mkdtemp(path.join(os.tmpdir(), 'proj-'))
  const taskId = '11111111-2222-3333-4444-555555555555'
  const encoded = `-Users-x--unmute-remote-local-${taskId}`
  await fs.mkdir(path.join(projects, encoded), { recursive: true })
  await fs.writeFile(path.join(projects, encoded, 'sess.jsonl'), '{}')
  const taskCwd = `/Users/x/.unmute/remote/local/${taskId}`
  const found = await locateTranscript(taskCwd, { projectsDir: projects })
  assert.equal(found, path.join(projects, encoded, 'sess.jsonl'))
})

test('locateTranscript returns null when absent', async () => {
  const projects = await fs.mkdtemp(path.join(os.tmpdir(), 'proj-'))
  const found = await locateTranscript('/Users/x/.unmute/remote/local/nope', { projectsDir: projects })
  assert.equal(found, null)
})
```

- [ ] **Step 3: Implement the locator**

```ts
// trace-reducer.ts
import { promises as fs } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { createLogger } from './log.ts'

const log = createLogger('trace-reducer')

function defaultProjectsDir(): string { return join(homedir(), '.claude', 'projects') }

/** Resolve the executor's JSONL by taskId (the cwd's last segment), which is the
 *  suffix of Claude's encoded project-dir name. Robust to the exact encoding:
 *  we match the dir whose name CONTAINS the taskId, then take the newest jsonl. */
export async function locateTranscript(taskCwd: string, opts: { projectsDir?: string } = {}): Promise<string | null> {
  const taskId = basename(taskCwd)
  const projectsDir = opts.projectsDir ?? defaultProjectsDir()
  let dirs: string[]
  try { dirs = await fs.readdir(projectsDir) } catch { return null }
  const match = dirs.find((d) => d.includes(taskId))
  if (!match) return null
  const dir = join(projectsDir, match)
  let files: string[]
  try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl')) } catch { return null }
  if (!files.length) return null
  const withMtime = await Promise.all(files.map(async (f) => ({ f, m: (await fs.stat(join(dir, f))).mtimeMs })))
  withMtime.sort((a, b) => b.m - a.m)
  return join(dir, withMtime[0].f)
}
```

- [ ] **Step 4: Run tests**

Run: `cd desktop && node --import tsx --test electron/remote/trace-reducer.test.ts`
Expected: PASS (2 locator tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/remote/trace-reducer.ts desktop/electron/remote/trace-reducer.test.ts desktop/electron/remote/fixtures/sample-transcript.jsonl
git commit -m "feat(memory): locate executor transcript by taskId + capture fixture"
```

### Task 8: Reduce the JSONL to a compact action trace

**Files:**
- Modify: `desktop/electron/remote/trace-reducer.ts`
- Test: `desktop/electron/remote/trace-reducer.test.ts`

**Interfaces:**
- Produces: `function reduceTranscript(jsonl: string, opts?: { maxChars?: number }): string`

- [ ] **Step 1: Write the failing test against the REAL fixture**

```ts
// append to trace-reducer.test.ts
import { reduceTranscript } from './trace-reducer.ts'

test('reduceTranscript distills tool calls + outcomes from the real fixture', async () => {
  const jsonl = await fs.readFile(new URL('./fixtures/sample-transcript.jsonl', import.meta.url), 'utf8')
  const out = reduceTranscript(jsonl)
  assert.ok(out.length > 0)
  assert.ok(out.length < jsonl.length)         // it actually compressed
  assert.doesNotMatch(out, /"usage"|"cache_creation"/) // dropped token metadata
  // Adjust the next assertion to a tool name actually present in YOUR fixture:
  // assert.match(out, /Bash|Read|Edit/)
})

test('reduceTranscript tolerates malformed lines', () => {
  const out = reduceTranscript('not json\n{"broken":')
  assert.equal(typeof out, 'string')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test electron/remote/trace-reducer.test.ts`
Expected: FAIL — `reduceTranscript` not defined.

- [ ] **Step 3: Implement the reducer (adjust selectors to the fixture's real shape)**

```ts
// append to trace-reducer.ts
// Distill a noisy Claude Code JSONL into an ordered, bounded markdown "action
// trace": tool calls (+ key inputs), tool results (ok/error), and the final
// assistant text. Deterministic extraction only — judgment is the librarian's.
// NOTE: selector paths below reflect the captured fixture; confirm against it.
export function reduceTranscript(jsonl: string, opts: { maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? 8000
  const out: string[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let ev: any
    try { ev = JSON.parse(line) } catch { continue }
    const msg = ev.message ?? ev
    const content = Array.isArray(msg?.content) ? msg.content : []
    for (const block of content) {
      if (block?.type === 'tool_use') {
        const input = JSON.stringify(block.input ?? {})
        out.push(`TOOL ${block.name}: ${input.slice(0, 240)}`)
      } else if (block?.type === 'tool_result') {
        const isErr = block.is_error === true
        const text = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content) ? block.content.map((c: any) => c?.text ?? '').join(' ') : ''
        out.push(`  -> ${isErr ? 'ERROR' : 'ok'}: ${String(text).replace(/\s+/g, ' ').slice(0, 200)}`)
      } else if (block?.type === 'text' && msg?.role === 'assistant') {
        const t = String(block.text ?? '').replace(/\s+/g, ' ').trim()
        if (t) out.push(`SAY: ${t.slice(0, 300)}`)
      }
    }
  }
  const joined = out.join('\n')
  return joined.length > maxChars ? joined.slice(-maxChars) : joined
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --import tsx --test electron/remote/trace-reducer.test.ts`
Expected: PASS. If selectors don't match the fixture, fix them now (this is the point of fixture-first).

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/remote/trace-reducer.ts desktop/electron/remote/trace-reducer.test.ts
git commit -m "feat(memory): reduce JSONL transcript to bounded action trace"
```

---

## Phase 5 — Librarian constitution + write-gate

### Task 9: New librarian inputs + JSONL feed + constitution prompt

**Files:**
- Modify: `desktop/electron/remote/librarian.ts`
- Test: `desktop/electron/remote/librarian.test.ts` (append; keep existing tests green)

**Interfaces:**
- Consumes: `listRecipes`, `writeRecipe`, `moveRecipe` (recipe-store); `locateTranscript`, `reduceTranscript` (trace-reducer).
- Produces (extends `RecipeSuggestion`):
  - `injectedRecipes?: Array<{ name: string; tier: 'nursery' | 'skill'; surface: string }>`
  - `outcome?: 'done' | 'failed'`
  - `writeEnabled?: boolean` on `LibrarianOpts` (default false).
  - The new `buildPrompt` output must include: the injected recipes (with their confidence/section structure), the reduced trace, the §5.1 dials, and (when `writeEnabled=false`) the instruction to write a `proposal.json` and mutate nothing.

- [ ] **Step 1: Write the failing test (prompt content)**

```ts
// append to librarian.test.ts — buildPrompt is currently private; expose a pure
// builder. Refactor: export `buildLibrarianPrompt(input)` and have the class call it.
import { buildLibrarianPrompt } from './librarian.ts'

test('librarian prompt encodes the dials + read-only proposal in gated mode', () => {
  const p = buildLibrarianPrompt({
    intent: 'scan my inboxes', outcome: 'failed',
    injectedRecipes: [{ name: 'gmail-inbox-sweep', tier: 'nursery', surface: 'gmail' }],
    reducedTrace: 'TOOL Bash: gmail\n  -> ERROR: profile 3 not found',
    existing: [], profile: '', writeEnabled: false,
    recipesDir: '/m/recipes', skillsDir: '/m/skills', proposalPath: '/lib/proposal.json', statusPath: '/lib/status.json',
  })
  assert.match(p, /Invariants|Definition of done/)        // hard-section rule present
  assert.match(p, /Defaults|Procedure/)                   // soft-section rule present
  assert.match(p, /down fast|demote/i)
  assert.match(p, /proposal\.json/)                       // read-only target
  assert.match(p, /do not (modify|write|change)/i)        // gated: no store mutation
  assert.match(p, /gmail-inbox-sweep/)                    // injected recipe named
})

test('librarian prompt allows writes when enabled', () => {
  const p = buildLibrarianPrompt({
    intent: 'x', outcome: 'done', injectedRecipes: [], reducedTrace: '', existing: [], profile: '',
    writeEnabled: true, recipesDir: '/m/recipes', skillsDir: '/m/skills', proposalPath: '/lib/proposal.json', statusPath: '/lib/status.json',
  })
  assert.match(p, /recipes\//)
  assert.doesNotMatch(p, /proposal\.json/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test electron/remote/librarian.test.ts`
Expected: FAIL — `buildLibrarianPrompt` not exported.

- [ ] **Step 3: Implement `buildLibrarianPrompt` + the constitution**

Extract the prompt into an exported pure function. Full constitution text (the crux — copy verbatim):

```ts
// librarian.ts — new exported builder
export interface LibrarianPromptInput {
  intent: string
  outcome: 'done' | 'failed'
  injectedRecipes: Array<{ name: string; tier: 'nursery' | 'skill'; surface: string }>
  reducedTrace: string
  existing: Array<{ name: string; surface: string; confidence: string; description: string }>
  profile: string
  writeEnabled: boolean
  recipesDir: string
  skillsDir: string
  proposalPath: string
  statusPath: string
}

export function buildLibrarianPrompt(i: LibrarianPromptInput): string {
  const injected = i.injectedRecipes.length
    ? i.injectedRecipes.map((r) => `  - ${r.name} (${r.tier}, surface=${r.surface})`).join('\n')
    : '  (none injected this run)'
  const index = i.existing.length
    ? i.existing.map((e) => `  - ${e.name} [${e.confidence}, ${e.surface}]: ${e.description}`).join('\n')
    : '  (memory is empty)'
  const writeRules = i.writeEnabled
    ? [
      `WRITE MODE: apply your decision directly to the store.`,
      `- Nursery (low/medium) recipes live under ${i.recipesDir}/<surface>/<name>.md`,
      `- Graduated (high) recipes live under ${i.skillsDir}/<surface>/<name>.md`,
      `- Promote/demote = move the file between those folders AND set the confidence field to match.`,
      `- New knowledge is ALWAYS created low-confidence in ${i.recipesDir}/<surface>/ — NEVER directly in ${i.skillsDir}/.`,
    ].join('\n')
    : [
      `READ-ONLY MODE (calibration): DO NOT modify, create, move, or delete ANY file under`,
      `${i.recipesDir} or ${i.skillsDir}, and DO NOT edit the profile.`,
      `Instead write your INTENDED decision as JSON to ${i.proposalPath} with shape:`,
      `{ "action": "no-op|create|promote|demote|update-counters", "name": "...", "surface": "...",`,
      `  "from_confidence": "low|medium|high|null", "to_confidence": "low|medium|high|null", "reason": "..." }`,
    ].join('\n')

  return [
    `[Unmute Remote — librarian]`,
    `You curate the user's long-term MEMORY so future terse commands succeed. You are the`,
    `ONLY writer. Be conservative: MOST runs change NOTHING — when in doubt, NO-OP.`,
    ``,
    `You run AUTONOMOUSLY — no user is watching. NEVER ask a question, NEVER wait for input.`,
    `Make the smallest safe change (or no-op) and finish.`,
    ``,
    `── The run that just finished ──`,
    `Intent: ${i.intent}`,
    `Outcome: ${i.outcome}`,
    `Recipes injected into this run:`,
    injected,
    ``,
    `What the executor ACTUALLY did (reduced action trace):`,
    i.reducedTrace || '  (no trace available)',
    ``,
    `── How to judge confidence (the dials) ──`,
    `Judge each INJECTED recipe by whether its claims were corroborated or CONTRADICTED by the`,
    `trace — NOT by whether the task merely succeeded or failed.`,
    `Only the HARD sections move confidence: "Invariants", "Definition of done", and named`,
    `structural facts (enumerations, locations, stable identifiers, documented gotchas).`,
    `The SOFT sections — "Defaults" and "Procedure" — are DESIGNED to be adapted; a deviation`,
    `there is NEVER a contradiction.`,
    `- CORROBORATED: the trace exercised a hard claim and it held -> runs_confirmed += 1, stamp`,
    `  last_used + last_verified. If thresholds are met, PROMOTE one tier`,
    `  (low->medium after 2 confirmations; medium->high after 3, both with no contradiction).`,
    `- CONTRADICTED: the trace shows a hard claim was FALSE (a named fact didn't hold and the`,
    `  model had to discover a different one, or a Definition-of-done invariant failed) ->`,
    `  DEMOTE one tier, runs_contradicted += 1, REWRITE the wrong part as a fresh LOW-confidence`,
    `  claim, re-hedge the phrasing.`,
    `- AMBIGUOUS (deviation only in soft sections, recipe not really exercised, or failure`,
    `  unrelated to the recipe — auth/network/novel sub-task) -> NO-OP (at most stamp last_used).`,
    ``,
    `── When to CREATE a new recipe (high bar) ──`,
    `Create a NEW low-confidence nursery recipe ONLY if ALL hold: (a) the run surfaced a`,
    `DURABLE, environmental fact worth a real Invariant or Known-failure-mode (not transient,`,
    `not situation-specific reasoning); (b) it cost non-trivial exploration the model would`,
    `otherwise redo; (c) the surface is plausibly recurring. Otherwise NO-OP. Unsure -> don't.`,
    ``,
    `── Posture ──`,
    `Lenient about creating (bloat is the enemy), SLOW to promote (needs repetition), FAST to`,
    `demote (one proven hard-fact contradiction). Never harden on one run. Never store brittle`,
    `UI steps as fact. Never persist transient state. Never merge two surfaces. A user FACT`,
    `(accounts, prefs, contacts) goes in the PROFILE (${i.profile ? 'see current profile below' : 'currently empty'}), not a recipe.`,
    i.profile.trim() ? `\nCurrent profile:\n${i.profile}` : '',
    ``,
    `── Existing memory (name [confidence, surface]: description) ──`,
    index,
    ``,
    `── Your output ──`,
    writeRules,
    ``,
    `When finished, write your status file (${i.statusPath}) state=done with a one-line`,
    `result.summary of your decision (e.g. "no-op", "demoted gmail-inbox-sweep low",`,
    `"created canva-export low"). Follow the loaded Unmute contract for the status write.`,
  ].filter((l) => l !== '').join('\n')
}
```

Wire the class `runOne()` to: (a) `locateTranscript(s.cwd)` then `reduceTranscript(file)` (fallback to `s.transcript` PTY tail if null); (b) load `existing` via `listRecipes` mapped to `{name,surface,confidence,description}`; (c) compute `proposalPath = join(libCwd,'proposal.json')`; (d) call `buildLibrarianPrompt({... writeEnabled: this.opts.writeEnabled ...})`. Add `writeEnabled?: boolean` to `LibrarianOpts` (default `false`).

- [ ] **Step 4: Run tests (new + existing)**

Run: `cd desktop && node --import tsx --test electron/remote/librarian.test.ts`
Expected: PASS (new prompt tests + existing librarian tests still green; the existing "applies a suggestion" test exercises the class flow with a fake executor — keep it passing by leaving the spawn/poll machinery intact).

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/remote/librarian.ts desktop/electron/remote/librarian.test.ts
git commit -m "feat(memory): librarian constitution + JSONL feed + read-only write-gate"
```

---

## Phase 6 — Trigger + mode plumbing (`task-manager.ts`)

### Task 10: Surface + mode on Task; nursery injection; injectedRecipes; recipe-bearing failed handoff

**Files:**
- Modify: `desktop/electron/remote/task-manager.ts`
- Test: `desktop/electron/remote/task-manager.test.ts` (exists — append)

**Interfaces:**
- Consumes: `detectSurface` (surface), `readNurseryRecipes`/`listRecipes`/`isStaleHigh` (recipe-store), extended `buildDispatch`, extended `installSkillsIntoCwd`.
- Produces:
  - `Task` gains `surface?: string`, `mode?: 'managed' | 'raw'`, `injectedRecipes?: Array<{ name: string; tier: 'nursery' | 'skill'; surface: string }>`.
  - `dispatch(intent: string, opts?: { surface?: string; mode?: 'managed' | 'raw' }): Promise<string>`.

- [ ] **Step 1: Write the failing test**

```ts
// append to task-manager.test.ts — uses the existing fake-executor harness in that file.
// Verify: (a) a managed task injects nursery recipes for its surface and records them;
// (b) a raw task injects nothing and records nothing.
// (See the file's existing helpers for makeFakeExecutor / tmp dirs; mirror them.)
test('managed dispatch injects + records nursery recipes for the detected surface', async () => {
  // arrange: write a nursery gmail recipe into a temp baseDir; construct TaskManager
  //          with a fake executor that captures the dispatched payload.
  // act: await tm.dispatch('scan my inboxes')  // detectSurface -> gmail, default managed
  // assert: captured payload matches /unverified lead/ and task.injectedRecipes has the gmail recipe.
})

test('raw dispatch skips injection and records no recipes', async () => {
  // act: await tm.dispatch('open me a coding session', { mode: 'raw' })
  // assert: captured payload does NOT match /unverified lead/; task.injectedRecipes is empty;
  //         no librarian.submit on done.
})
```

Fill these in using the concrete fake-executor pattern already in `task-manager.test.ts` (capture `writeStdin` payloads; drive a `done` status write). Keep them deterministic (inject `now`, `trustAcceptMs: 0`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test electron/remote/task-manager.test.ts`
Expected: FAIL — `dispatch` ignores opts / no injection.

- [ ] **Step 3: Implement**

In `dispatch()` (around `task-manager.ts:221-255`):
```ts
async dispatch(intent: string, opts: { surface?: string; mode?: 'managed' | 'raw' } = {}): Promise<string> {
  const id = randomUUID()
  const dir = join(this.opts.baseDir, this.opts.userKey!, id)
  const surface = opts.surface ?? detectSurface(intent)
  const mode = opts.mode ?? 'managed'
  // ... existing scaffold/meta/contract/hooks ...
  let injectedRecipes: Task['injectedRecipes'] = []
  let nurseryForDispatch: Array<{ name: string; confidence: Confidence; body: string }> = []
  let staleNotes: string[] = []
  if (mode === 'managed') {
    await installSkillsIntoCwd(dir, { surface, baseDir: this.opts.baseDir })
    await installProfileIntoCwd(dir, this.opts.baseDir)
    const nursery = await readNurseryRecipes(surface, this.opts.baseDir)
    nurseryForDispatch = nursery.map((r) => ({ name: r.frontmatter.name, confidence: r.frontmatter.confidence, body: r.body }))
    const graduated = await listRecipes({ tier: 'skill', surface, baseDir: this.opts.baseDir })
    const now = this.clock()
    staleNotes = graduated.filter((r) => isStaleHigh(r, now))
      .map((r) => `${r.frontmatter.name} is high-confidence but unverified for a while — confirm before relying.`)
    injectedRecipes = [
      ...nursery.map((r) => ({ name: r.frontmatter.name, tier: 'nursery' as const, surface })),
      ...graduated.map((r) => ({ name: r.frontmatter.name, tier: 'skill' as const, surface })),
    ]
  }
  // store on task
  task.surface = surface; task.mode = mode; task.injectedRecipes = injectedRecipes
  // ... spawn/settle ...
  const payload = buildDispatch({ intent, statusPath, recipeScratchPath, nurseryRecipes: nurseryForDispatch, staleNotes })
  // ... rest unchanged ...
}
```
Add the three fields to the `Task` interface (`task-manager.ts:48-78`). Import `detectSurface`, `readNurseryRecipes`, `listRecipes`, `isStaleHigh`, and `type Confidence`.

In `transition()`, change the librarian handoff so it (a) runs for managed tasks only, (b) fires on `done` always and on `failed` when `injectedRecipes` is non-empty, (c) passes `injectedRecipes` + `outcome`:
```ts
// helper
private handToLibrarian(task: Task, outcome: 'done' | 'failed') {
  if (task.mode !== 'managed' || !this.opts.librarian) return
  if (outcome === 'failed' && !(task.injectedRecipes?.length)) return
  const tlog = log.child({ taskId: task.id })
  tlog.event('librarian-handoff', { taskId: task.id, outcome })
  void this.opts.librarian.submit({
    taskId: task.id, intent: task.intent, scratchPath: task.recipeScratchPath, cwd: task.cwd,
    summary: task.result?.summary, detail: task.result?.detail, category: task.category,
    transcript: cleanTranscriptTail(this.outputBuffers.get(task.id) ?? ''),
    injectedRecipes: task.injectedRecipes ?? [], outcome,
  }).catch((e) => tlog.error('librarian submit failed', { error: (e as Error).message }))
}
```
Call `this.handToLibrarian(task, 'done')` in the `done` case (replacing the inline submit at `:479-491`) and `this.handToLibrarian(task, 'failed')` in the `failed` case (`:506-519`). Persist `surface`/`mode` into `meta.json` (`:244`) so a rehydrated task keeps its mode (extend the receipt + `rehydrate()` read at `:605-644`).

- [ ] **Step 4: Run tests**

Run: `cd desktop && node --import tsx --test electron/remote/task-manager.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/remote/task-manager.ts desktop/electron/remote/task-manager.test.ts
git commit -m "feat(memory): surface+mode tasks, nursery injection, recipe-bearing failed handoff"
```

---

## Phase 7 — Router emits surface + mode

### Task 11: `RouteDecision` gains surface + mode

**Files:**
- Modify: `desktop/electron/remote/router.ts`
- Test: `desktop/electron/remote/router.test.ts` (exists — append)

**Interfaces:**
- Produces: `RouteDecision` gains `surface?: string` and `mode?: 'managed' | 'raw'`. The decision JSON the router session writes includes them; the parser reads them (default `mode: 'managed'`, `surface` omitted → caller falls back to `detectSurface`).

- [ ] **Step 1: Write the failing test**

```ts
// append to router.test.ts — mirror the file's existing decision-parse tests.
test('router decision parses surface + mode', async () => {
  // Using the file's existing fake-executor-that-writes-decision harness, have it
  // write: {"action":"new","intent":"open me a coding session","mode":"raw"}
  // assert decision.mode === 'raw'
  // and: {"action":"new","intent":"scan my inboxes","surface":"gmail","mode":"managed"}
  // assert decision.surface === 'gmail' && decision.mode === 'managed'
})
test('router decision defaults mode to managed when absent', () => {
  // parse a decision JSON without mode -> mode === 'managed'
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test electron/remote/router.test.ts`
Expected: FAIL — surface/mode not parsed.

- [ ] **Step 3: Implement**

Extend the `RouteDecision` type and the JSON parse in `router.ts` to read `surface` (string | undefined) and `mode` (`'managed' | 'raw'`, default `'managed'`). Update the routing prompt (the `buildRoutingPrompt` text) to instruct the classifier to additionally emit:
- `surface`: the app/tool the task operates on (gmail, google-sheets, google-calendar, canva, youtube, …) or omit if none.
- `mode`: `raw` for "open me a session to work in" / open-ended coding where injected hints would pollute long reasoning; `managed` for short, surface-operating dictated tasks. Ambiguous → `raw`.

Keep the existing `action`/`targetTaskId`/`intent` contract and failsafe unchanged.

- [ ] **Step 4: Run tests**

Run: `cd desktop && node --import tsx --test electron/remote/router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/remote/router.ts desktop/electron/remote/router.test.ts
git commit -m "feat(memory): router emits surface + managed/raw mode"
```

---

## Phase 8 — Gardening: `gardening.ts`

### Task 12: Gardening pass (dedupe / prune / stale-flag) + retire dead skills exports

**Files:**
- Create: `desktop/electron/remote/gardening.ts`
- Test: `desktop/electron/remote/gardening.test.ts`
- Modify: `desktop/electron/remote/skills.ts` (delete now-dead `sharedSkillsDir`/`skillsIndex`/`listSharedSkills`)

**Interfaces:**
- Produces:
  - `interface GardenAction { kind: 'prune' | 'stale-flag' | 'dedupe'; name: string; surface: string; reason: string }`
  - `async function planGardening(opts: { baseDir?: string; nowMs: number; pruneContradictedRatio?: number; idleMs?: number }): Promise<GardenAction[]>`
  - `async function applyGardening(actions: GardenAction[], opts: { baseDir?: string }): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// gardening.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeRecipe, listRecipes } from './recipe-store.ts'
import { planGardening, applyGardening } from './gardening.ts'

const fm = (o = {}) => ({ name: 'r', surface: 'gmail', description: 'd', confidence: 'low',
  runs_confirmed: 0, runs_contradicted: 0, created: '', last_used: '', last_verified: '', ...o } as any)

test('planGardening prunes a low recipe with many contradictions and no confirmations', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'garden-'))
  await writeRecipe({ frontmatter: fm({ name: 'bad', runs_contradicted: 3, runs_confirmed: 0 }), body: 'b' }, base)
  await writeRecipe({ frontmatter: fm({ name: 'good', runs_confirmed: 4, runs_contradicted: 0 }), body: 'b' }, base)
  const actions = await planGardening({ baseDir: base, nowMs: Date.now() })
  assert.ok(actions.some((a) => a.kind === 'prune' && a.name === 'bad'))
  assert.ok(!actions.some((a) => a.name === 'good'))
  await applyGardening(actions, { baseDir: base })
  const left = await listRecipes({ baseDir: base })
  assert.deepEqual(left.map((r) => r.frontmatter.name).sort(), ['good'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --import tsx --test electron/remote/gardening.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// gardening.ts
import { promises as fs } from 'node:fs'
import { createLogger } from './log.ts'
import { listRecipes, isStaleHigh, type Recipe } from './recipe-store.ts'

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
  log.event('gardening-planned', { count: actions.length })
  return actions
}

export async function applyGardening(actions: GardenAction[], opts: { baseDir?: string }): Promise<void> {
  const recipes = await listRecipes({ baseDir: opts.baseDir })
  const byName = new Map(recipes.map((r) => [r.frontmatter.name, r]))
  for (const a of actions) {
    if (a.kind !== 'prune') continue // stale-flag is informational; dedupe deferred
    const r = byName.get(a.name)
    if (!r?.path) continue
    try { await fs.rm(r.path, { force: true }); log.event('gardening-pruned', { name: a.name, reason: a.reason }) }
    catch (e) { log.warn('gardening prune failed', { name: a.name, error: (e as Error).message }) }
  }
}
```

Then delete the dead exports from `skills.ts` (`sharedSkillsDir`, `skillsIndex`, `listSharedSkills`) and fix any remaining imports (the librarian no longer imports them after Task 9; `librarian.test.ts`'s first two tests import `sharedSkillsDir`/`sessionSkillsDir` — update them to the new `recipe-store` equivalents or move those two assertions to `skills-surface.test.ts`).

- [ ] **Step 4: Run tests (whole suite)**

Run: `cd desktop && npm test`
Expected: PASS across all `*.test.ts` (confirms the dead-export removal didn't break imports).

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/remote/gardening.ts desktop/electron/remote/gardening.test.ts desktop/electron/remote/skills.ts desktop/electron/remote/librarian.test.ts
git commit -m "feat(memory): gardening pass + retire flat-skills exports"
```

---

## Phase 9 — Wiring + manual end-to-end (`init.ts`)

### Task 13: Wire write-gate, mode plumbing, gardening schedule

**Files:**
- Modify: `desktop/electron/remote/init.ts` (Electron glue — NOT unit-tested, mirrors existing pattern)

**Interfaces:**
- Consumes: extended `dispatch(intent, opts)`, extended `RouteDecision`, `Librarian({ writeEnabled })`, `planGardening`/`applyGardening`.

- [ ] **Step 1: Add the setting + gate**

Add `librarianWriteEnabled: boolean` to `RemoteSettings` (default `false`, `init.ts:61-112`). Pass it to the `Librarian` constructor (`init.ts:530`):
```ts
const librarian = new Librarian({ executorFactory: librarianExecutorFactory, writeEnabled: settings.get('librarianWriteEnabled') === true })
```
Add an IPC handler `remote:set-librarian-write-enabled` mirroring the other setters, and surface it in `remote:get-settings`.

- [ ] **Step 2: Thread surface + mode from the router into dispatch**

In `dispatchFromCapture()` (`init.ts:416-465`), pass the router's `surface` + `mode` to new-task dispatch:
```ts
log.event('routed-as-new', { via: 'router', surface: decision.surface, mode: decision.mode })
return manager.dispatch(decision.intent || raw, { surface: decision.surface, mode: decision.mode })
```
For the no-router fallback path (`:462-464`), call `manager.dispatch(cleaned)` (TaskManager defaults: `detectSurface` + managed) — unchanged call, new defaults apply.

- [ ] **Step 3: Schedule gardening (gated)**

After `startMaintenance()` (`init.ts:546-551`), add a daily gardening timer that runs only when writes are enabled:
```ts
const GARDEN_MS = 24 * 60 * 60 * 1000
const gardenTimer = setInterval(() => {
  if (settings.get('librarianWriteEnabled') !== true) return
  void (async () => {
    const actions = await planGardening({ nowMs: Date.now() })
    log.event('gardening-sweep', { planned: actions.length })
    await applyGardening(actions, {})
  })().catch((e) => log.warn('gardening sweep failed', { error: (e as Error).message }))
}, GARDEN_MS)
;(gardenTimer as { unref?: () => void }).unref?.()
```

- [ ] **Step 4: Typecheck + full suite**

Run: `cd desktop && npm run typecheck && npm test`
Expected: typecheck clean (the one pre-existing `overlay.ts:168` baseline error is acceptable; no NEW errors), all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron/remote/init.ts
git commit -m "feat(memory): wire write-gate, surface/mode plumbing, gardening schedule"
```

### Task 14: Manual end-to-end smoke (read-only librarian)

**Files:** none (verification only).

- [ ] **Step 1: Seed a nursery recipe**

Create `~/.unmute/remote/recipes/gmail/inbox-sweep.md` with the Task 1 SAMPLE content (low confidence, the "enumerate ALL profiles" invariant).

- [ ] **Step 2: Run the app in dev**

Run: `cd desktop && npm run dev`. Dispatch (voice or `remote:dispatch`) "scan my inboxes for events."

- [ ] **Step 3: Verify injection**

In the session log (`~/.unmute/remote/logs/<runId>/`), confirm `dispatch-payload-built` shows `nursery: 1`, and the task ran with the hedged lead. Confirm a raw task ("open me a coding session") shows `nursery: 0`.

- [ ] **Step 4: Verify the read-only librarian proposal**

After the task reaches `done`/`failed`, confirm a `proposal.json` was written under the task's `librarian/` dir and that **nothing** under `~/.unmute/remote/recipes/` or `skills/` changed (write-gate off). Read the proposal: it should name the injected recipe and a sensible action (no-op / promote / demote / create) with a reason referencing the trace.

- [ ] **Step 5: Document the result**

Append observed proposals to `desktop/docs/memory-system/02-readonly-calibration-notes.md` (create it). These notes calibrate the §5.3 thresholds before flipping `librarianWriteEnabled` on. Commit the notes.

```bash
git add desktop/docs/memory-system/02-readonly-calibration-notes.md
git commit -m "docs(memory): read-only librarian calibration notes (run 1)"
```

---

## Deferred (explicitly out of THIS plan — do not silently implement)

- **Dedupe (gardening):** merging two overlapping recipes needs semantic judgment → a librarian-assisted pass, not the deterministic sweep. `planGardening` emits no dedupe actions yet.
- **Flipping `librarianWriteEnabled` ON:** a separate, deliberate step after calibration notes show the librarian's proposals are trustworthy. Not done here.
- **Contract `contract-text.ts` changes:** none needed — §7 already says the recipe scratch hint is optional. The doer-self-report demotion (delta H) is satisfied by the librarian now inferring from the trace; no rewrite.

---

## Self-Review

**1. Spec coverage (`01-substrate-and-confidence-delta.md`):**
- §3.1 layout → Tasks 1-2 (recipe-store paths). §3.2 frontmatter → Task 1. §3.3 nursery-vs-graduated injection → Tasks 5-6, 10.
- §4.1 skills.ts → Tasks 6, 12. §4.2 dispatch injection → Tasks 5, 10. §4.3 injectedRecipes → Task 10. §4.4 librarian trigger/input/constitution/gate → Tasks 9, 10. §4.5 status preserved → untouched (verified: no status-file.ts change). §4.6 trace pipeline → Tasks 7-8.
- §5 + §5.1 dials → Task 9 prompt (verbatim). §6 cutover (write-gate default off) → Tasks 9, 13. §7 OD-resolutions → encoded (OD-1 clean slate; OD-2 surface+general; OD-3 done/recipe-failed/not-stuck → Task 10; OD-4 build reducer → Tasks 7-8; OD-5 lazy surfaces → no predefined taxonomy).
- §9 stubs: router mode → Task 11; freshness → Tasks 3, 10 (isStaleHigh + staleNotes); gardening → Task 12.
- Gap check: managed/raw orchestration-always-on (§0a) — verified Tasks 10/13 only gate injection + librarian, never registry/status/overlay (those code paths are untouched). ✔

**2. Placeholder scan:** Task 10 and Task 11 tests are described as patterns to fill against the existing fake-executor harnesses in `task-manager.test.ts`/`router.test.ts` rather than fully inlined — flagged explicitly because those harnesses must be read to mirror their exact shape; every other step carries complete code. Task 7 deliberately defers the reducer's exact selectors to the captured fixture (honesty gate, not a placeholder).

**3. Type consistency:** `injectedRecipes` item shape `{ name; tier: 'nursery'|'skill'; surface }` is identical in Tasks 9, 10. `Confidence` imported from `recipe-store.ts` in dispatch-prompt (Task 5), task-manager (Task 10). `dispatch(intent, opts?)` signature defined in Task 10, consumed in Task 13. `installSkillsIntoCwd(cwd, opts)` new signature defined in Task 6, consumed in Task 10. ✔
