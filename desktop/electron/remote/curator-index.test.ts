import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readSkillsFrom, buildCuratedIndexFrom, stripFrontmatter } from './curator-index.ts'

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'ci-'))

async function writeSkill(dir: string, name: string, description: string, body: string): Promise<void> {
  const skillDir = path.join(dir, name)
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`)
}

test('stripFrontmatter: removes the leading --- block, returns the body', () => {
  assert.equal(stripFrontmatter('---\nname: x\ndescription: y\n---\nGoal…\nStep 1'), 'Goal…\nStep 1')
  assert.equal(stripFrontmatter('no frontmatter here'), 'no frontmatter here')   // resilient — returned whole
})

test('readSkillsFrom: lists every SKILL.md subdir, parsing name/description/body', async () => {
  const dir = await tmp()
  await writeSkill(dir, 'foo', 'does foo things', 'Goal: foo')
  await writeSkill(dir, 'bar', 'does bar things', 'Goal: bar')
  const skills = await readSkillsFrom(dir)
  assert.equal(skills.length, 2)
  const foo = skills.find((s) => s.name === 'foo')
  assert.equal(foo?.description, 'does foo things')
  assert.equal(foo?.body, 'Goal: foo')
})

test('readSkillsFrom: a missing directory returns [] — never throws (project with no .claude/skills yet)', async () => {
  const dir = await tmp()
  const skills = await readSkillsFrom(path.join(dir, 'does-not-exist'))
  assert.deepEqual(skills, [])
})

test('readSkillsFrom: an entry with no SKILL.md (loose file, or empty dir) is silently skipped', async () => {
  const dir = await tmp()
  await fs.mkdir(path.join(dir, 'not-a-skill'))
  await fs.writeFile(path.join(dir, 'loose.md'), 'not a skill dir')
  const skills = await readSkillsFrom(dir)
  assert.deepEqual(skills, [])
})

test('buildCuratedIndexFrom: unions GLOBAL and PROJECT-SCOPED skills — the dedup bug this module fixes', async () => {
  const globalDir = await tmp()
  const projectRoot = await tmp()
  await writeSkill(globalDir, 'unmute-release-pipeline', 'ship a release', 'Goal: ship')
  // Project-scoped skill lives at <projectRoot>/.claude/skills/<name>/SKILL.md —
  // exactly the layout that was previously invisible to curatedIndex.
  await writeSkill(path.join(projectRoot, '.claude', 'skills'), 'unmute-test-build', 'private test build', 'Goal: test build')
  const result = await buildCuratedIndexFrom([], globalDir, [projectRoot])
  const names = result.map((s) => s.name).sort()
  assert.deepEqual(names, ['unmute-release-pipeline', 'unmute-test-build'])
  const projSkill = result.find((s) => s.name === 'unmute-test-build')
  assert.equal(projSkill?.description, 'private test build')
})

test('buildCuratedIndexFrom: a project root with no .claude/skills dir at all is skipped without throwing', async () => {
  const globalDir = await tmp()
  const projectRoot = await tmp()   // no .claude/skills under here
  const result = await buildCuratedIndexFrom([], globalDir, [projectRoot])
  assert.deepEqual(result, [])
})

test('buildCuratedIndexFrom: a name present in BOTH global and a project keeps the GLOBAL copy', async () => {
  const globalDir = await tmp()
  const projectRoot = await tmp()
  await writeSkill(globalDir, 'shared-name', 'the global version', 'global body')
  await writeSkill(path.join(projectRoot, '.claude', 'skills'), 'shared-name', 'the project version', 'project body')
  const result = await buildCuratedIndexFrom([], globalDir, [projectRoot])
  assert.equal(result.length, 1)
  assert.equal(result[0].description, 'the global version')
})

test('buildCuratedIndexFrom: an OWNED name with no SKILL.md on disk still appears (empty description/body) — ownership is the authority', async () => {
  const globalDir = await tmp()
  const result = await buildCuratedIndexFrom(['ghost-skill'], globalDir, [])
  assert.deepEqual(result, [{ name: 'ghost-skill', description: '', body: '' }])
})
