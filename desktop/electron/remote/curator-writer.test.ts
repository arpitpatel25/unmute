import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderSkillMd, contentHash, writeSkill, detectDrift } from './curator-writer.ts'
import { curatorPaths, readLedger, appendLedger } from './curator-store.ts'

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cw-'))
const draft = { name: 'pr-review', description: 'Reviews PRs the way this user does', body: '# pr-review\n\n**Goal** — …' }

test('renderSkillMd: frontmatter carries the flag; origin stamp is conditional', () => {
  const md = renderSkillMd(draft, { originStamp: true })
  assert.ok(md.startsWith('---\n'))
  assert.ok(md.includes('disable-model-invocation: true'))   // D8 — always
  assert.ok(md.includes('origin: unmute'))
  assert.ok(!renderSkillMd(draft, { originStamp: false }).includes('origin:'))
  assert.ok(md.includes(draft.body))
})

test('writeSkill create: ledger-first, atomic dir write, hash recorded', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  const p = curatorPaths(root)
  const r = await writeSkill({ draft, kind: 'create', userEdited: false, proposalId: 'p1', paths: p, skillsRoot: skills, originStamp: true })
  assert.equal(r.ok, true)
  const onDisk = await fs.readFile(path.join(skills, 'pr-review', 'SKILL.md'), 'utf8')
  const l = await readLedger(p)
  const created = l.entries.find((e) => e.action === 'created')
  assert.equal(created?.skill, 'pr-review')
  assert.equal(created?.contentHash, contentHash(onDisk))
})

test('writeSkill: HARD STOP on collision with a skill we did not author (D10)', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  await fs.mkdir(path.join(skills, 'pr-review'), { recursive: true })
  await fs.writeFile(path.join(skills, 'pr-review', 'SKILL.md'), 'user-owned')
  const r = await writeSkill({ draft, kind: 'create', userEdited: false, proposalId: 'p1', paths: curatorPaths(root), skillsRoot: skills, originStamp: false })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'collision')
  assert.equal(await fs.readFile(path.join(skills, 'pr-review', 'SKILL.md'), 'utf8'), 'user-owned')  // untouched
})

test('writeSkill update: allowed only for ledger-owned names; user-edited accept recorded', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  const p = curatorPaths(root)
  await writeSkill({ draft, kind: 'create', userEdited: false, proposalId: 'p1', paths: p, skillsRoot: skills, originStamp: false })
  const r2 = await writeSkill({ draft: { ...draft, body: 'v2' }, kind: 'update', userEdited: true, proposalId: 'p2', paths: p, skillsRoot: skills, originStamp: false, diff: '-a+b' })
  assert.equal(r2.ok, true)
  const l = await readLedger(p)
  assert.ok(l.entries.some((e) => e.action === 'user-edited-accept' && e.diff === '-a+b'))
})

test('detectDrift: hand-edited curated skill flagged once', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  const p = curatorPaths(root)
  await writeSkill({ draft, kind: 'create', userEdited: false, proposalId: 'p1', paths: p, skillsRoot: skills, originStamp: false })
  await fs.appendFile(path.join(skills, 'pr-review', 'SKILL.md'), '\nhand edit')
  assert.deepEqual(await detectDrift(p, skills), ['pr-review'])
  assert.deepEqual(await detectDrift(p, skills), [])   // already flagged at this hash — not re-flagged
})
