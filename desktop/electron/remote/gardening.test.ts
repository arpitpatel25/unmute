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
