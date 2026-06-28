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

import { cleanupMemory, memoryUsage } from './gardening.ts'

const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'garden-'))

test('cleanupMemory evicts stale never-confirmed low recipes, keeps recent or confirmed ones', async () => {
  const base = await tmp()
  const now = 1_800_000_000_000
  await writeRecipe({ frontmatter: fm({ name: 'stale-low', confidence: 'low', runs_confirmed: 0, last_used: iso(now - 60 * DAY), created: iso(now - 60 * DAY) }), body: 'b' }, base)
  await writeRecipe({ frontmatter: fm({ name: 'recent-low', confidence: 'low', runs_confirmed: 0, last_used: iso(now - 2 * DAY) }), body: 'b' }, base)
  await writeRecipe({ frontmatter: fm({ name: 'stale-confirmed', confidence: 'low', runs_confirmed: 3, last_used: iso(now - 60 * DAY) }), body: 'b' }, base)
  const res = await cleanupMemory({ baseDir: base, nowMs: now })
  assert.deepEqual(res.evicted, ['stale-low'])
  const left = (await listRecipes({ baseDir: base })).map((r) => r.frontmatter.name).sort()
  assert.deepEqual(left, ['recent-low', 'stale-confirmed'])
})

test('cleanupMemory demotes a stale-high recipe to medium', async () => {
  const base = await tmp()
  const now = 1_800_000_000_000
  await writeRecipe({ frontmatter: fm({ name: 'old-skill', confidence: 'high', last_verified: iso(now - 400 * DAY) }), body: '## Invariants\n- x' }, base)
  const res = await cleanupMemory({ baseDir: base, nowMs: now })
  assert.deepEqual(res.demoted, ['old-skill'])
  assert.equal((await listRecipes({ tier: 'skill', baseDir: base })).length, 0)
  assert.equal((await listRecipes({ tier: 'nursery', baseDir: base }))[0].frontmatter.confidence, 'medium')
})

test('cleanupMemory removes exact-name duplicates, keeping the highest-confidence one', async () => {
  const base = await tmp()
  const now = 1_800_000_000_000
  // Same name in two tiers (nursery low + graduated high) → two real files on disk.
  await writeRecipe({ frontmatter: fm({ name: 'gmail-sweep', confidence: 'low', last_used: iso(now - 10 * DAY), runs_confirmed: 1 }), body: 'b' }, base)
  await writeRecipe({ frontmatter: fm({ name: 'gmail-sweep', confidence: 'high', last_used: iso(now - 1 * DAY), last_verified: iso(now - 1 * DAY) }), body: 'b' }, base)
  const res = await cleanupMemory({ baseDir: base, nowMs: now })
  assert.deepEqual(res.deduped, ['gmail-sweep'])
  const left = await listRecipes({ baseDir: base })
  assert.equal(left.length, 1)
  assert.equal(left[0].frontmatter.confidence, 'high') // the graduated copy survives
})

test('memoryUsage reports total bytes and recipe/skill counts', async () => {
  const base = await tmp()
  await writeRecipe({ frontmatter: fm({ name: 'a', confidence: 'low' }), body: 'hello' }, base)
  await writeRecipe({ frontmatter: fm({ name: 'b', confidence: 'high' }), body: 'world' }, base)
  const u = await memoryUsage({ baseDir: base })
  assert.equal(u.recipeCount, 1)
  assert.equal(u.skillCount, 1)
  assert.ok(u.bytes > 0)
})
