import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  claudeCommandItems, codexCommandItems, titleFor, syncClaudeBridge, bridgeDirFor,
  codexExtraRoots, SkillCatalog, type ClaudeCommandRaw, type CodexSkillRaw,
} from './skill-catalog.ts'

test('claude commands keep skills, drop the REPL-only built-ins', () => {
  const items = claudeCommandItems([
    { name: 'frontend-design', description: 'Guidance for visual design (user)' },
    { name: 'clear', description: 'Clear conversation history' },
    { name: 'model', description: 'Set the AI model' },
    { name: 'code-review', description: 'Review the current diff', argumentHint: '[<pr#>]' },
  ])
  // A tagged skill outranks an untagged built-in, whatever the alphabet says.
  assert.deepEqual(items.map(i => i.name), ['frontend-design', 'code-review'])
  assert.equal(items[0].token, '/frontend-design')
  assert.equal(items[0].scope, 'Personal')
  // The "(user)" marker is provenance, not part of the sentence.
  assert.equal(items[0].description, 'Guidance for visual design')
  assert.equal(items[1].argumentHint, '[<pr#>]')
})

test('claude command scope covers project, plugin and built-in', () => {
  const items = claudeCommandItems([
    { name: 'deploy', description: 'Ship it (project)' },
    { name: 'superpowers:brainstorming', description: 'Explore intent' },
    { name: 'init', description: 'Initialize a CLAUDE.md' },
  ])
  const scope = Object.fromEntries(items.map(i => [i.name, i.scope]))
  assert.equal(scope['deploy'], 'Project')
  assert.equal(scope['superpowers:brainstorming'], 'Plugin')
  assert.equal(scope['init'], 'Built-in')
  // Built-ins sort last: the menu exists to find skills.
  assert.equal(items[items.length - 1].name, 'init')
})

test('codex skills dedupe the same name from several roots and use $', () => {
  const raw: CodexSkillRaw[] = [
    { name: 'hyperframes', description: 'Video entry point', scope: 'user', path: '/a/hyperframes/SKILL.md', enabled: true },
    { name: 'hyperframes', description: 'Video entry point', scope: 'user', path: '/b/hyperframes/SKILL.md', enabled: true },
    { name: 'retired', description: 'Off', scope: 'user', path: '/a/retired/SKILL.md', enabled: false },
    { name: 'captions', description: 'Repo one', scope: 'repo', path: '/p/.agents/skills/captions/SKILL.md', enabled: true },
  ]
  const items = codexCommandItems(raw)
  assert.deepEqual(items.map(i => i.name), ['captions', 'hyperframes'])
  assert.deepEqual(items.map(i => i.token), ['$captions', '$hyperframes'])
  assert.equal(items[0].scope, 'Project')
  assert.equal(items[1].scope, 'Personal')
})

test('descriptions collapse to one line', () => {
  const [item] = codexCommandItems([{ name: 'x', description: `first line\n\n   second    line `, enabled: true }])
  assert.equal(item.description, 'first line second line')
})

test('titleFor keeps a plugin prefix and title-cases the rest', () => {
  assert.equal(titleFor('frontend-design'), 'Frontend Design')
  assert.equal(titleFor('superpowers:test-driven-development'), 'superpowers: Test Driven Development')
})

async function tempTree(): Promise<{ base: string; home: string; cwd: string; codex: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-'))
  const home = path.join(base, 'home')
  const cwd = path.join(base, 'project')
  const codex = path.join(base, 'codex-skills')
  await fs.mkdir(path.join(home, '.claude', 'skills'), { recursive: true })
  await fs.mkdir(cwd, { recursive: true })
  await fs.mkdir(codex, { recursive: true })
  return { base, home, cwd, codex }
}

async function codexSkill(root: string, name: string): Promise<CodexSkillRaw> {
  await fs.mkdir(path.join(root, name), { recursive: true })
  await fs.writeFile(path.join(root, name, 'SKILL.md'), `---\nname: ${name}\n---\nbody\n`)
  return { name, description: name, path: path.join(root, name, 'SKILL.md'), scope: 'user', enabled: true }
}

test('the bridge links codex skills claude cannot already see', async () => {
  const { base, home, cwd, codex } = await tempTree()
  const mine = await codexSkill(codex, 'music-to-video')
  const shared = await codexSkill(codex, 'hyperframes')
  // Claude already owns this name personally: linking it would list it twice.
  await fs.mkdir(path.join(home, '.claude', 'skills', 'hyperframes'), { recursive: true })

  const dir = await syncClaudeBridge(cwd, [mine, shared], { baseDir: base, homeDir: home })
  assert.equal(dir, bridgeDirFor(cwd, base))
  const skillsDir = path.join(dir, '.claude', 'skills')
  assert.deepEqual(await fs.readdir(skillsDir), ['music-to-video'])
  // A symlink, so an edit to the real skill is what the session reads.
  assert.equal(await fs.readlink(path.join(skillsDir, 'music-to-video')), path.join(codex, 'music-to-video'))
  assert.equal(await fs.readFile(path.join(skillsDir, 'music-to-video', 'SKILL.md'), 'utf8'), '---\nname: music-to-video\n---\nbody\n')
})

test('a project skill of the same name is not bridged either', async () => {
  const { base, home, cwd, codex } = await tempTree()
  const skill = await codexSkill(codex, 'deploy')
  await fs.mkdir(path.join(cwd, '.claude', 'skills', 'deploy'), { recursive: true })
  const dir = await syncClaudeBridge(cwd, [skill], { baseDir: base, homeDir: home })
  assert.deepEqual(await fs.readdir(path.join(dir, '.claude', 'skills')), [])
})

test('the bridge reconciles: stale links go, correct links are left alone', async () => {
  const { base, home, cwd, codex } = await tempTree()
  const gone = await codexSkill(codex, 'gone')
  const kept = await codexSkill(codex, 'kept')
  const dir = await syncClaudeBridge(cwd, [gone, kept], { baseDir: base, homeDir: home })
  const skillsDir = path.join(dir, '.claude', 'skills')
  const before = await fs.lstat(path.join(skillsDir, 'kept'))

  await syncClaudeBridge(cwd, [kept], { baseDir: base, homeDir: home })
  assert.deepEqual(await fs.readdir(skillsDir), ['kept'])
  const after = await fs.lstat(path.join(skillsDir, 'kept'))
  assert.equal(before.birthtimeMs, after.birthtimeMs, 'an unchanged link must not be recreated under a live session')
})

test('the bridge refuses names that are not safe directory entries', async () => {
  const { base, home, cwd } = await tempTree()
  const dir = await syncClaudeBridge(cwd, [
    { name: '../escape', path: '/tmp/escape/SKILL.md', enabled: true },
    { name: 'plugin:skill', path: '/tmp/p/SKILL.md', enabled: true },
    { name: 'nopath', enabled: true },
  ], { baseDir: base, homeDir: home })
  assert.deepEqual(await fs.readdir(path.join(dir, '.claude', 'skills')), [])
})

test('codex extra roots point at claude personal skills', () => {
  assert.deepEqual(codexExtraRoots('/Users/x'), ['/Users/x/.claude/skills'])
})

test('a cold cwd answers empty and fills in after the probe', async () => {
  const claude: ClaudeCommandRaw[] = [{ name: 'code-review', description: 'Review (user)' }]
  let claudeCalls = 0, codexCalls = 0, updated = 0
  const catalog = new SkillCatalog({
    claudeCommands: async () => { claudeCalls++; return claude },
    codexSkills: async () => { codexCalls++; return [] },
    onUpdated: () => { updated++ },
    baseDir: await fs.mkdtemp(path.join(os.tmpdir(), 'cat-')),
  })
  // Never blocks the payload: the first read is empty by contract.
  assert.deepEqual(catalog.commands('claude', '/p'), [])
  await catalog.refresh('claude', '/p')
  assert.deepEqual(catalog.commands('claude', '/p').map(i => i.name), ['code-review'])
  assert.equal(updated, 1)
  assert.equal(claudeCalls > 0, true)
  assert.equal(codexCalls > 0, true, 'the claude list needs the bridge, which needs codex')
})

test('a codex chat never probes claude', async () => {
  let claudeCalls = 0
  const catalog = new SkillCatalog({
    claudeCommands: async () => { claudeCalls++; return [] },
    codexSkills: async () => [{ name: 'hyperframes', description: 'd', enabled: true }],
    baseDir: await fs.mkdtemp(path.join(os.tmpdir(), 'cat-')),
  })
  await catalog.refresh('codex', '/p')
  assert.deepEqual(catalog.commands('codex', '/p').map(i => i.token), ['$hyperframes'])
  assert.equal(claudeCalls, 0)
})

test('a failed probe keeps the last good list', async () => {
  let fail = false
  const catalog = new SkillCatalog({
    claudeCommands: async () => [],
    codexSkills: async () => { if (fail) throw new Error('codex went away'); return [{ name: 'hyperframes', description: 'd', enabled: true }] },
    baseDir: await fs.mkdtemp(path.join(os.tmpdir(), 'cat-')),
  })
  await catalog.refresh('codex', '/p')
  fail = true
  await catalog.refresh('codex', '/p')
  assert.deepEqual(catalog.commands('codex', '/p').map(i => i.name), ['hyperframes'])
})

test('a stale entry re-probes, a fresh one does not', async () => {
  let calls = 0, now = 1_000
  const catalog = new SkillCatalog({
    claudeCommands: async () => [],
    codexSkills: async () => { calls++; return [] },
    ttlMs: 60_000,
    now: () => now,
    baseDir: await fs.mkdtemp(path.join(os.tmpdir(), 'cat-')),
  })
  await catalog.refresh('codex', '/p')
  assert.equal(calls, 1)
  catalog.commands('codex', '/p')
  assert.equal(calls, 1)
  now += 61_000
  catalog.commands('codex', '/p')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(calls, 2)
})
