import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractSkillUses, normalizeSkillName, recordSkillUsage, readSkillStats } from './skill-usage.ts'

function transcriptLine(blocks: Array<{ type: string; name?: string; input?: object }>): string {
  return JSON.stringify({ type: 'assistant', message: { content: blocks } })
}
const skillUse = (skill: string) => transcriptLine([{ type: 'tool_use', name: 'Skill', input: { skill } }])

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'skill-usage-'))
}

test('normalizeSkillName: plain, plugin-scoped, dir-scoped, .md suffix', () => {
  assert.equal(normalizeSkillName('youtube-latest-video'), 'youtube-latest-video')
  assert.equal(normalizeSkillName('superpowers:brainstorming'), 'brainstorming')
  assert.equal(normalizeSkillName('apps/web:deploy'), 'deploy')
  assert.equal(normalizeSkillName('live-sports-scores.md'), 'live-sports-scores')
  assert.equal(normalizeSkillName('  '), '')
})

test('extractSkillUses: finds Skill tool_use entries, in order, skipping noise', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'use the Skill please' }] } }),
    skillUse('youtube-latest-video'),
    transcriptLine([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
    skillUse('plugin:x-compose-save-draft'),
    'this line is not json {{{',
    skillUse('youtube-latest-video'),
  ].join('\n')
  assert.deepEqual(extractSkillUses(jsonl), ['youtube-latest-video', 'x-compose-save-draft', 'youtube-latest-video'])
})

test('recordSkillUsage: one task credits a skill ONCE (runs = distinct tasks, not invocations)', async () => {
  const dir = await tmpDir()
  const transcriptPath = path.join(dir, 't.jsonl')
  const statsPath = path.join(dir, 'stats.json')
  // Task invokes the same skill twice + another once.
  await fs.writeFile(transcriptPath, [skillUse('scores'), skillUse('scores'), skillUse('drafts')].join('\n'))
  const credited = await recordSkillUsage({ taskId: 'task-1', transcriptPath, statsPath })
  assert.deepEqual(credited.sort(), ['drafts', 'scores'])
  const stats = await readSkillStats(statsPath)
  assert.equal(stats.skills['scores'].runs, 1, 'double invocation in one task = one run')
  assert.equal(stats.skills['drafts'].runs, 1)
  assert.ok(stats.skills['scores'].lastUsed, 'lastUsed stamped')
})

test('recordSkillUsage: idempotent re-credit — repeat done parks add NOTHING; new transcript tail adds the delta', async () => {
  const dir = await tmpDir()
  const transcriptPath = path.join(dir, 't.jsonl')
  const statsPath = path.join(dir, 'stats.json')
  await fs.writeFile(transcriptPath, skillUse('scores'))
  await recordSkillUsage({ taskId: 'task-1', transcriptPath, statsPath })
  // Same transcript re-credited (a session parking done again) → no change.
  const again = await recordSkillUsage({ taskId: 'task-1', transcriptPath, statsPath })
  assert.deepEqual(again, [])
  assert.equal((await readSkillStats(statsPath)).skills['scores'].runs, 1)
  // The thread continues and invokes a NEW skill → only the delta credits.
  await fs.appendFile(transcriptPath, '\n' + skillUse('drafts') + '\n' + skillUse('scores'))
  const delta = await recordSkillUsage({ taskId: 'task-1', transcriptPath, statsPath })
  assert.deepEqual(delta, ['drafts'], 'scores already credited for this task; drafts is new')
  const stats = await readSkillStats(statsPath)
  assert.equal(stats.skills['scores'].runs, 1, 'still one — same task')
  assert.equal(stats.skills['drafts'].runs, 1)
})

test('recordSkillUsage: a DIFFERENT task using the same skill bumps runs (trust accrues per task)', async () => {
  const dir = await tmpDir()
  const statsPath = path.join(dir, 'stats.json')
  for (const taskId of ['task-1', 'task-2', 'task-3']) {
    const transcriptPath = path.join(dir, `${taskId}.jsonl`)
    await fs.writeFile(transcriptPath, skillUse('scores'))
    await recordSkillUsage({ taskId, transcriptPath, statsPath })
  }
  assert.equal((await readSkillStats(statsPath)).skills['scores'].runs, 3)
})

test('recordSkillUsage: missing transcript or empty usage is a quiet no-op', async () => {
  const dir = await tmpDir()
  const statsPath = path.join(dir, 'stats.json')
  assert.deepEqual(await recordSkillUsage({ taskId: 't', transcriptPath: path.join(dir, 'nope.jsonl'), statsPath }), [])
  const transcriptPath = path.join(dir, 't.jsonl')
  await fs.writeFile(transcriptPath, transcriptLine([{ type: 'tool_use', name: 'Bash', input: {} }]))
  assert.deepEqual(await recordSkillUsage({ taskId: 't', transcriptPath, statsPath }), [])
  assert.deepEqual((await readSkillStats(statsPath)).skills, {})
})

test('readSkillStats: corrupt or missing ledger degrades to empty, never throws', async () => {
  const dir = await tmpDir()
  const statsPath = path.join(dir, 'stats.json')
  assert.deepEqual((await readSkillStats(statsPath)).skills, {})
  await fs.writeFile(statsPath, '{ not json')
  assert.deepEqual((await readSkillStats(statsPath)).skills, {})
})

test('recordSkillUsage: concurrent credits serialize (no lost updates)', async () => {
  const dir = await tmpDir()
  const statsPath = path.join(dir, 'stats.json')
  const jobs = ['a', 'b', 'c', 'd'].map(async (id) => {
    const transcriptPath = path.join(dir, `${id}.jsonl`)
    await fs.writeFile(transcriptPath, skillUse('scores'))
    return recordSkillUsage({ taskId: id, transcriptPath, statsPath })
  })
  await Promise.all(jobs)
  assert.equal((await readSkillStats(statsPath)).skills['scores'].runs, 4)
})
