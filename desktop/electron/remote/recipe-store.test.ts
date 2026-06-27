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
