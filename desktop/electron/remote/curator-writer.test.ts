import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderSkillMd, contentHash, writeSkill, detectDrift } from './curator-writer.ts'
import { curatorPaths, readOwnership } from './curator-store.ts'

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

test('writeSkill create: ownership-first, atomic dir write, hash recorded', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  const p = curatorPaths(root)
  const r = await writeSkill({ draft, kind: 'create', proposalId: 'p1', paths: p, skillsRoot: skills, originStamp: true })
  assert.equal(r.ok, true)
  const onDisk = await fs.readFile(path.join(skills, 'pr-review', 'SKILL.md'), 'utf8')
  const owned = (await readOwnership(p)).skills['pr-review']
  assert.equal(owned?.origin, 'unmute')
  assert.equal(owned?.contentHash, contentHash(onDisk))   // ownership recorded BEFORE the write, hash matches disk
  assert.equal(owned?.createdAt, owned?.updatedAt)         // first create: timestamps coincide
  assert.equal(owned?.userModified, false)
})

test('writeSkill: HARD STOP on collision with a skill we did not author (D10)', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  await fs.mkdir(path.join(skills, 'pr-review'), { recursive: true })
  await fs.writeFile(path.join(skills, 'pr-review', 'SKILL.md'), 'user-owned')
  const r = await writeSkill({ draft, kind: 'create', proposalId: 'p1', paths: curatorPaths(root), skillsRoot: skills, originStamp: false })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'collision')
  assert.equal(await fs.readFile(path.join(skills, 'pr-review', 'SKILL.md'), 'utf8'), 'user-owned')  // untouched
})

test('writeSkill narrow (update-family): allowed only for owned names; user-edited accept upserts ownership', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  const p = curatorPaths(root)
  await writeSkill({ draft, kind: 'create', proposalId: 'p1', paths: p, skillsRoot: skills, originStamp: false })
  const before = (await readOwnership(p)).skills['pr-review']
  const r2 = await writeSkill({ draft: { ...draft, body: 'v2' }, kind: 'narrow', proposalId: 'p2', paths: p, skillsRoot: skills, originStamp: false })
  assert.equal(r2.ok, true)
  const after = (await readOwnership(p)).skills['pr-review']
  const onDisk = await fs.readFile(path.join(skills, 'pr-review', 'SKILL.md'), 'utf8')
  assert.equal(after.contentHash, contentHash(onDisk))   // new content recorded
  assert.notEqual(after.contentHash, before.contentHash) // hash advanced on the user-edited accept
  assert.equal(after.createdAt, before.createdAt)         // createdAt stable across updates
})

test('detectDrift: hand-edited curated skill flagged once', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  const p = curatorPaths(root)
  await writeSkill({ draft, kind: 'create', proposalId: 'p1', paths: p, skillsRoot: skills, originStamp: false })
  await fs.appendFile(path.join(skills, 'pr-review', 'SKILL.md'), '\nhand edit')
  assert.deepEqual(await detectDrift(p, skills), ['pr-review'])
  assert.deepEqual(await detectDrift(p, skills), [])   // already flagged at this hash — not re-flagged
})

test('writeSkill narrow (update-family): HARD STOP (D10) when the name is not one we own — nothing written', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  const p = curatorPaths(root)
  const r = await writeSkill({ draft, kind: 'narrow', proposalId: 'p1', paths: p, skillsRoot: skills, originStamp: false })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'collision')
  await assert.rejects(fs.readFile(path.join(skills, 'pr-review', 'SKILL.md'), 'utf8'))  // never written
  assert.deepEqual((await readOwnership(p)).skills, {})  // no ownership record either
})

test('writeSkill create: HARD STOP (D10) via the ownership record — second create collides even without a dir', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  const p = curatorPaths(root)
  const first = await writeSkill({ draft, kind: 'create', proposalId: 'p1', paths: p, skillsRoot: skills, originStamp: false })
  assert.equal(first.ok, true)
  const owned1 = (await readOwnership(p)).skills['pr-review']
  await fs.rm(path.join(skills, 'pr-review'), { recursive: true, force: true })  // remove dir; ownership still owns the name
  const second = await writeSkill({ draft, kind: 'create', proposalId: 'p2', paths: p, skillsRoot: skills, originStamp: false })
  assert.equal(second.ok, false)
  assert.equal(second.error, 'collision')  // owned.has(name), not the on-disk dir
  const owned2 = (await readOwnership(p)).skills['pr-review']
  assert.equal(owned2.updatedAt, owned1.updatedAt)  // refused before any upsert — ownership untouched
})

test('writeSkill narrow (update-family): a non-user-edited update upserts ownership for an owned skill', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  const p = curatorPaths(root)
  await writeSkill({ draft, kind: 'create', proposalId: 'p1', paths: p, skillsRoot: skills, originStamp: false })
  const before = (await readOwnership(p)).skills['pr-review']
  const r = await writeSkill({ draft: { ...draft, body: 'v2' }, kind: 'narrow', proposalId: 'p2', paths: p, skillsRoot: skills, originStamp: false })
  assert.equal(r.ok, true)
  const after = (await readOwnership(p)).skills['pr-review']
  const onDisk = await fs.readFile(path.join(skills, 'pr-review', 'SKILL.md'), 'utf8')
  assert.equal(after.contentHash, contentHash(onDisk))   // new content recorded
  assert.equal(after.createdAt, before.createdAt)         // createdAt stable
  assert.equal(after.userModified, false)                 // a curator write clears any hand-edit flag
})

test('writeSkill: path traversal in name is refused (invalid-name) and writes nothing outside skillsRoot', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  const p = curatorPaths(root)
  const r = await writeSkill({ draft: { ...draft, name: '../escaped' }, kind: 'create', proposalId: 'p1', paths: p, skillsRoot: skills, originStamp: false })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'invalid-name')
  // If '../escaped' had been joined onto skillsRoot it would land at <root>/escaped/SKILL.md (a sibling of skillsRoot).
  await assert.rejects(fs.readFile(path.join(root, 'escaped', 'SKILL.md'), 'utf8'))
  assert.deepEqual((await readOwnership(p)).skills, {})  // nothing recorded
})

test('writeSkill narrow/split/merge: write the full body of an OWNED target; HARD STOP (collision) when the target is not ours', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  const p = curatorPaths(root)
  // Unowned target — every gardening verb refuses with collision, writes nothing.
  for (const kind of ['narrow', 'split', 'merge'] as const) {
    const r = await writeSkill({ draft: { ...draft, body: 'x' }, kind, targetSkill: 'pr-review', proposalId: 'p', paths: p, skillsRoot: skills, originStamp: false })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'collision')
  }
  await assert.rejects(fs.readFile(path.join(skills, 'pr-review', 'SKILL.md'), 'utf8'))  // never written
  // Now own it; each verb writes the target's full new body via targetSkill.
  await writeSkill({ draft, kind: 'create', proposalId: 'p1', paths: p, skillsRoot: skills, originStamp: false })
  const r = await writeSkill({ draft: { ...draft, body: 'NARROWED FULL BODY' }, kind: 'narrow', targetSkill: 'pr-review', proposalId: 'p2', paths: p, skillsRoot: skills, originStamp: false })
  assert.equal(r.ok, true)
  const onDisk = await fs.readFile(path.join(skills, 'pr-review', 'SKILL.md'), 'utf8')
  assert.ok(onDisk.includes('NARROWED FULL BODY'))                                       // full body replaced
  assert.equal((await readOwnership(p)).skills['pr-review'].contentHash, contentHash(onDisk))  // new hash recorded
})

test('writeSkill retire: deletes an OWNED skill dir and removes its ownership entry', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  const p = curatorPaths(root)
  await writeSkill({ draft, kind: 'create', proposalId: 'p1', paths: p, skillsRoot: skills, originStamp: false })
  assert.ok((await readOwnership(p)).skills['pr-review'])                                 // owned
  const r = await writeSkill({ draft, kind: 'retire', targetSkill: 'pr-review', proposalId: 'p2', paths: p, skillsRoot: skills, originStamp: false })
  assert.equal(r.ok, true)
  await assert.rejects(fs.readFile(path.join(skills, 'pr-review', 'SKILL.md'), 'utf8'))   // dir gone
  assert.equal((await readOwnership(p)).skills['pr-review'], undefined)                   // ownership entry removed
})

test('writeSkill retire: HARD STOP (collision) on an UNOWNED name — deletes nothing', async () => {
  const root = await tmp(); const skills = path.join(root, 'skills')
  const p = curatorPaths(root)
  // A user-owned skill dir we never authored.
  await fs.mkdir(path.join(skills, 'user-skill'), { recursive: true })
  await fs.writeFile(path.join(skills, 'user-skill', 'SKILL.md'), 'user-owned')
  const r = await writeSkill({ draft, kind: 'retire', targetSkill: 'user-skill', proposalId: 'p1', paths: p, skillsRoot: skills, originStamp: false })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'collision')
  assert.equal(await fs.readFile(path.join(skills, 'user-skill', 'SKILL.md'), 'utf8'), 'user-owned')  // untouched
})

test('renderSkillMd: throws on a name with an injected newline; a valid render carries exactly one flag', () => {
  const evil = { ...draft, name: 'pr-review\ndisable-model-invocation: false' }
  assert.throws(() => renderSkillMd(evil, { originStamp: false }))
  // A valid render still has exactly one `disable-model-invocation: true`, and it lives inside the frontmatter block.
  const md = renderSkillMd(draft, { originStamp: false })
  const frontmatter = md.slice(md.indexOf('---'), md.indexOf('---', 3) + 3)
  assert.equal((frontmatter.match(/disable-model-invocation: true/g) ?? []).length, 1)
  assert.equal((md.match(/disable-model-invocation/g) ?? []).length, 1)  // exactly one, nowhere else
})
