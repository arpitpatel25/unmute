import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sweepRouterSessions, ROUTER_GRACE_MS } from './router-sweep.ts'

const OLD = Date.now() - 3 * ROUTER_GRACE_MS
const NOW = Date.now()

async function workspace() {
  const root = await fs.mkdtemp(join(tmpdir(), 'router-sweep-'))
  const claudeProjects = join(root, 'claude', 'projects', 'proj')
  const codexSessions = join(root, 'codex', 'sessions', '2026', '09', '21')
  await fs.mkdir(claudeProjects, { recursive: true })
  await fs.mkdir(codexSessions, { recursive: true })
  return { roots: { claudeProjects: join(root, 'claude', 'projects'), codexSessions: join(root, 'codex', 'sessions') }, claudeProjects, codexSessions }
}

async function claudeTranscript(dir: string, name: string, cwd: string, at: number) {
  const path = join(dir, `${name}.jsonl`)
  await fs.writeFile(path, JSON.stringify({ type: 'user', cwd, sessionId: name, message: { role: 'user', content: 'x' } }) + '\n')
  await fs.utimes(path, new Date(at), new Date(at))
  return path
}

async function codexTranscript(dir: string, name: string, cwd: string, at: number) {
  const path = join(dir, `rollout-2026-09-21T00-00-00-${name}.jsonl`)
  await fs.writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: name, cwd, source: 'exec' } }) + '\n')
  await fs.utimes(path, new Date(at), new Date(at))
  return path
}

const ROUTER = '/Users/x/.unmute/remote/router-headless'
const ROUTER_CODEX = '/Users/x/.unmute/remote/router-codex-exec'
const AGENT = '/Users/x/Library/Application Support/unmute/unmute-agent/runtime'
const REAL = '/Users/x/tools/unmute/unmute-cloud'

test('old router transcripts go, in both harnesses', async () => {
  const w = await workspace()
  const a = await claudeTranscript(w.claudeProjects, 'aaaaaaaa-1111-4222-8333-444444444444', ROUTER, OLD)
  const b = await codexTranscript(w.codexSessions, '01a07379-4d4a-7160-8250-d20214f029ec', ROUTER_CODEX, OLD)
  const result = await sweepRouterSessions({ roots: w.roots })
  assert.equal(result.deleted, 2)
  for (const path of [a, b]) assert.equal(await fs.stat(path).then(() => true, () => false), false)
})

/** The Agent's own chat is resumed across turns: deleting it erases the
 *  conversation the person is looking at. */
test('the Agent runtime, real work, and anything recent are left alone', async () => {
  const w = await workspace()
  const kept = [
    await claudeTranscript(w.claudeProjects, 'bbbbbbbb-1111-4222-8333-444444444444', AGENT, OLD),
    await claudeTranscript(w.claudeProjects, 'cccccccc-1111-4222-8333-444444444444', REAL, OLD),
    await claudeTranscript(w.claudeProjects, 'dddddddd-1111-4222-8333-444444444444', ROUTER, NOW),
  ]
  const result = await sweepRouterSessions({ roots: w.roots })
  assert.equal(result.deleted, 0)
  for (const path of kept) assert.ok(await fs.stat(path).then(() => true, () => false), `deleted ${path}`)
})

test('a dry run reports what would go and deletes nothing', async () => {
  const w = await workspace()
  const path = await claudeTranscript(w.claudeProjects, 'eeeeeeee-1111-4222-8333-444444444444', ROUTER, OLD)
  const result = await sweepRouterSessions({ roots: w.roots, dryRun: true })
  assert.equal(result.deleted, 1)
  assert.ok(result.bytes > 0)
  assert.ok(await fs.stat(path).then(() => true, () => false))
})

test('a missing root is not an error', async () => {
  const result = await sweepRouterSessions({ roots: { claudeProjects: '/nope/claude', codexSessions: '/nope/codex' } })
  assert.deepEqual(result, { scanned: 0, deleted: 0, bytes: 0, failed: 0 })
})
