import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDispatch } from './dispatch-prompt.ts'

test('typed payload carries the per-task path + intent, not the full contract (PRD #3)', () => {
  const out = buildDispatch({
    intent: 'extract ~/Downloads/report.zip',
    statusPath: '/home/u/.unmute/remote/local/t1/status.json',
  })
  assert.match(out, /\/home\/u\/\.unmute\/remote\/local\/t1\/status\.json/) // dynamic path present
  assert.match(out, /extract ~\/Downloads\/report\.zip/) // intent present
  assert.ok(out.length < 600, `payload should stay terse, was ${out.length} bytes`)
})

test('recipe scratch path is included only when provided', () => {
  const without = buildDispatch({ intent: 'x', statusPath: '/s.json' })
  assert.doesNotMatch(without, /recipe\.json/i)
  const withScratch = buildDispatch({ intent: 'x', statusPath: '/s.json', recipeScratchPath: '/r/recipe.json' })
  assert.match(withScratch, /\/r\/recipe\.json/)
})

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
