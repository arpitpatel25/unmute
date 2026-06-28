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

test('serializeRecipe collapses newlines in string scalars so frontmatter stays single-line', () => {
  const out = serializeRecipe({
    frontmatter: {
      name: 'x', surface: 'gmail', description: 'line one\nline two\n  tabbed', confidence: 'low',
      runs_confirmed: 0, runs_contradicted: 0, created: '', last_used: '', last_verified: '',
    },
    body: 'b',
  })
  // The description must not introduce a second line inside the frontmatter block.
  const fm = out.slice(3, out.indexOf('\n---', 3))
  const scalarLines = fm.split('\n').filter((l) => l.trim())
  assert.ok(scalarLines.every((l) => l.includes(':')), 'every scalar line must keep its key')
  const back = parseRecipe(out, '/tmp/x.md')!
  assert.equal(back.frontmatter.description, 'line one line two tabbed')
})

// ── Task 2: tier↔folder mapping, paths, list/read/write ──────────────────────
import { promises as fs2 } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  tierForConfidence, dirForRecipe, listRecipes, readNurseryRecipes, writeRecipe, recipesDir, graduatedDir,
} from './recipe-store.ts'

async function tmpBase() { return fs2.mkdtemp(path.join(os.tmpdir(), 'recipe-')) }
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

test('concurrent writeRecipe to the same name never corrupts or leaves a .tmp (unique tmp)', async () => {
  const base = await tmpBase()
  // 8 writers race on the SAME recipe path. With a shared tmp name one rename
  // would hit ENOENT and reject; with a unique tmp all succeed, last wins.
  await Promise.all(Array.from({ length: 8 }, (_, i) =>
    writeRecipe({ frontmatter: fm({ name: 'hot', confidence: 'low', description: `d${i}` }), body: `body ${i}\n` }, base)))
  const all = await listRecipes({ baseDir: base, surface: 'gmail' })
  assert.equal(all.length, 1, 'exactly one recipe file, parseable (not partial)')
  assert.equal(all[0].frontmatter.name, 'hot')
  const files = await fs2.readdir(path.join(recipesDir(base), 'gmail'))
  assert.ok(files.every((f) => !f.endsWith('.tmp')), 'no orphan .tmp left behind')
})

// ── Task 3: promote/demote (move) + freshness predicate ──────────────────────
import { moveRecipe, isStaleHigh, FRESHNESS_WINDOW_MS, parseRecipe as _p } from './recipe-store.ts'

test('moveRecipe promotes nursery->skill and removes the old file', async () => {
  const base = await tmpBase()
  const p = await writeRecipe({ frontmatter: fm({ name: 'm', confidence: 'medium' }), body: '## Invariants\n- z\n' }, base)
  const r = parseRecipe(await fs2.readFile(p, 'utf8'), p)!
  const moved = await moveRecipe(r, 'high', base)
  assert.equal(moved.frontmatter.confidence, 'high')
  assert.equal((await listRecipes({ tier: 'skill', baseDir: base })).length, 1)
  assert.equal((await listRecipes({ tier: 'nursery', baseDir: base })).length, 0)
  await assert.rejects(fs2.access(p)) // old file gone
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

import { selectNurseryWithinBudget } from './recipe-store.ts'

const rec = (over: any, bodyLen: number) =>
  ({ frontmatter: fm(over), body: 'x'.repeat(bodyLen), path: '' } as any)

test('selectNurseryWithinBudget: under budget keeps everything (executor judges relevance)', () => {
  const recipes = [rec({ name: 'a' }, 100), rec({ name: 'b' }, 100), rec({ name: 'c' }, 100)]
  const { kept, trimmed } = selectNurseryWithinBudget(recipes, 6000)
  assert.equal(kept.length, 3)
  assert.equal(trimmed, 0)
})

test('selectNurseryWithinBudget: over budget trims the least-proven/oldest, in rank order', () => {
  // Budget fits ~2.5 bodies. Ranking: confidence desc, then recency desc.
  const hi = rec({ name: 'hi', confidence: 'medium', last_used: '2026-06-01' }, 1000)
  const midRecent = rec({ name: 'mid', confidence: 'low', last_used: '2026-06-20' }, 1000)
  const lowOld = rec({ name: 'old', confidence: 'low', last_used: '2026-01-01' }, 1000)
  const { kept, trimmed } = selectNurseryWithinBudget([lowOld, midRecent, hi], 2200)
  assert.deepEqual(kept.map((r: any) => r.frontmatter.name), ['hi', 'mid']) // medium first, then recenter low
  assert.equal(trimmed, 1) // the oldest low got trimmed
})

test('selectNurseryWithinBudget: always keeps the top-ranked recipe even if it alone exceeds budget', () => {
  const big = rec({ name: 'big', confidence: 'medium' }, 9000)
  const { kept, trimmed } = selectNurseryWithinBudget([big, rec({ name: 'b' }, 100)], 6000)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].frontmatter.name, 'big')
  assert.equal(trimmed, 1)
})
