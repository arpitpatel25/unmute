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
