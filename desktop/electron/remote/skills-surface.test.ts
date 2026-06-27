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
