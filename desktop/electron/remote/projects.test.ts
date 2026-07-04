import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProjectPaths, curateProjects, projectSlug } from './projects.ts'

test('parseProjectPaths extracts absolute project paths; tolerates junk', () => {
  const raw = JSON.stringify({ projects: { '/Users/u/tools/app': {}, '/Users/u/repo': {}, 'not-absolute': {} } })
  assert.deepEqual(parseProjectPaths(raw), ['/Users/u/tools/app', '/Users/u/repo'])
  assert.deepEqual(parseProjectPaths('{broken'), [])
  assert.deepEqual(parseProjectPaths('{}'), [])
})

test('projectSlug folds every non-alphanumeric run to a dash (verified encoding)', () => {
  assert.equal(projectSlug('/Users/u/tools/calorify_ai/backend'), '-Users-u-tools-calorify-ai-backend')
  assert.equal(projectSlug('/Users/u/.claude-worktrees/x'), '-Users-u-claude-worktrees-x')
})

test('curateProjects drops noise + dead dirs, ranks by recency, caps', async () => {
  const paths = [
    '/Users/u/tools/app',                     // alive, old
    '/Users/u/tools/hot',                     // alive, recent
    '/Users/u/.claude-worktrees/app/x',       // noise
    '/Users/u/.unmute/remote/local/abc',      // noise (our scratch)
    '/Users/u/gone',                          // dead
    '/',                                      // junk
  ]
  const mtimes: Record<string, number> = { '/Users/u/tools/app': 100, '/Users/u/tools/hot': 900 }
  const out = await curateProjects(paths, {
    exists: async (p) => p !== '/Users/u/gone',
    mtimeMs: async (p) => mtimes[p] ?? 0,
  }, 10)
  assert.deepEqual(out.map((p) => p.path), ['/Users/u/tools/hot', '/Users/u/tools/app'])
  assert.equal(out[0].name, 'hot')
  const capped = await curateProjects(paths, { exists: async () => true, mtimeMs: async () => 0 }, 1)
  assert.equal(capped.length, 1)
})
