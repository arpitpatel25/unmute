import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { searchSessionCatalog } from './catalog.ts'

test('on-demand catalog returns exact identities, cwd, user text, and artifact references', async () => {
  const root = await fs.mkdtemp(join(os.tmpdir(), 'session-catalog-'))
  const claudeProjects = join(root, '.claude', 'projects', '-Users-me-launch')
  const codexSessions = join(root, '.codex', 'sessions')
  await fs.mkdir(claudeProjects, { recursive: true })
  await fs.mkdir(codexSessions, { recursive: true })
  const id = 'aaaaaaaa-1111-2222-8333-444444444444'
  await fs.writeFile(join(claudeProjects, `${id}.jsonl`), [
    JSON.stringify({ type: 'user', cwd: '/Users/me/launch', message: { role: 'user', content: 'Update the pricing launch sheet at https://docs.example.test/sheet/42' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Done' } }),
  ].join('\n'))

  const results = await searchSessionCatalog('pricing sheet', {
    claudeProjects: join(root, '.claude', 'projects'), codexSessions,
  })

  assert.equal(results[0]?.sessionId, id)
  assert.equal(results[0]?.harness, 'claude')
  assert.equal(results[0]?.cwd, '/Users/me/launch')
  assert.match(results[0]?.userText ?? '', /pricing launch sheet/)
  assert.deepEqual(results[0]?.artifacts, ['https://docs.example.test/sheet/42'])
})

test('catalog is lexical, ranked, and bounded', async () => {
  const root = await fs.mkdtemp(join(os.tmpdir(), 'session-catalog-'))
  const claudeProjects = join(root, 'claude')
  const codexSessions = join(root, 'codex', '2026', '09', '05')
  await fs.mkdir(claudeProjects, { recursive: true })
  await fs.mkdir(codexSessions, { recursive: true })
  await fs.writeFile(join(claudeProjects, 'aaaaaaaa-1111-2222-8333-444444444444.jsonl'), '{"type":"user","message":{"role":"user","content":"pricing pricing migration"}}')
  await fs.writeFile(join(codexSessions, 'rollout-now-bbbbbbbb-1111-4222-8333-444444444444.jsonl'), '{"type":"event_msg","payload":{"type":"user_message","message":"pricing notes"}}')

  const results = await searchSessionCatalog('pricing migration', { claudeProjects, codexSessions }, 1)

  assert.equal(results.length, 1)
  assert.equal(results[0]?.sessionId, 'aaaaaaaa-1111-2222-8333-444444444444')
})
