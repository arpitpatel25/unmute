import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  discoverSessions, isAgentOwnSession, readSession, unmuteTaskIdOf, type SessionRoots,
} from './scan'

async function fixture(): Promise<{ roots: SessionRoots; dir: string }> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'agent-scan-'))
  const roots: SessionRoots = {
    claudeProjects: join(dir, 'claude', 'projects'),
    codexSessions: join(dir, 'codex', 'sessions'),
    agentRuntime: join(dir, 'appsupport', 'unmute-agent'),
  }
  await fs.mkdir(join(roots.claudeProjects, '-Users-me-repo'), { recursive: true })
  await fs.mkdir(join(roots.codexSessions, '2026', '08', '26'), { recursive: true })
  return { roots, dir }
}

const claudeTranscript = (cwd: string, opening: string) => [
  JSON.stringify({ type: 'last-prompt', sessionId: 'claude-session-1' }),
  JSON.stringify({ type: 'user', cwd, message: { content: [{ type: 'text', text: opening }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }] } }),
].join('\n')

test('discovery finds every harness and orders by last touched', async () => {
  const { roots, dir } = await fixture()
  try {
    const older = join(roots.claudeProjects, '-Users-me-repo', 'a.jsonl')
    const newer = join(roots.codexSessions, '2026', '08', '26', 'rollout-b.jsonl')
    await fs.writeFile(older, claudeTranscript('/Users/me/repo', 'the older one'))
    await fs.writeFile(newer, JSON.stringify({ type: 'session_meta', payload: { session_id: 'cx', cwd: '/Users/me/other' } }))
    await fs.utimes(older, new Date(1_000_000), new Date(1_000_000))
    await fs.utimes(newer, new Date(2_000_000), new Date(2_000_000))

    const found = await discoverSessions(roots)
    assert.equal(found.length, 2)
    assert.equal(found[0]!.harness, 'codex', 'newest first')
    assert.equal(found[1]!.harness, 'claude')
    assert.ok(found[0]!.lastTouchedAt > found[1]!.lastTouchedAt)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

/**
 * The Agent reading its own turns back as the user's work is the failure that
 * earned it a private working directory in the first place. An index that
 * re-mixed them would undo that silently.
 */
test("the Agent's own sessions are never discovered", async () => {
  const { roots, dir } = await fixture()
  try {
    const slug = roots.agentRuntime.replace(/\//g, '-')
    await fs.mkdir(join(roots.claudeProjects, slug), { recursive: true })
    await fs.writeFile(
      join(roots.claudeProjects, slug, 'own.jsonl'),
      claudeTranscript(roots.agentRuntime, 'an Agent turn'),
    )
    await fs.writeFile(
      join(roots.claudeProjects, '-Users-me-repo', 'theirs.jsonl'),
      claudeTranscript('/Users/me/repo', 'a real session'),
    )
    const found = await discoverSessions(roots)
    assert.equal(found.length, 1)
    assert.match(found[0]!.path, /theirs\.jsonl$/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a missing root is empty, not an error', async () => {
  const found = await discoverSessions({
    claudeProjects: '/nope/claude', codexSessions: '/nope/codex', agentRuntime: '/nope/agent',
  })
  assert.deepEqual(found, [])
})

test('reading a session yields identity, opening, closing and a real project name', async () => {
  const { roots, dir } = await fixture()
  try {
    const path = join(roots.claudeProjects, '-Users-me-repo', 'a.jsonl')
    await fs.writeFile(path, claudeTranscript('/Users/me/calorify_ai', 'Audit the billing migrations'))
    const [found] = await discoverSessions(roots)
    const record = await readSession(found!)
    assert.equal(record.sessionId, 'claude-session-1')
    assert.equal(record.opening, 'Audit the billing migrations')
    assert.equal(record.closing, 'All done.')
    assert.equal(record.project, 'calorify_ai', 'the project is what a person would call it')
    assert.equal(record.unmuteTaskId, undefined)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

/**
 * `sessions_list` reported `project` as a uuid for every Unmute-started session,
 * because the task's cwd is a scratch directory named after the task. The uuid
 * is a join key, not a name — recovering it is what lets the index show the
 * task's real name instead.
 */
test('an Unmute scratch cwd becomes a task id, not a project name', async () => {
  const { roots, dir } = await fixture()
  try {
    const path = join(roots.claudeProjects, '-Users-me-repo', 'a.jsonl')
    const taskId = '3dc48045-b226-463e-a5bd-33c480dc7844'
    await fs.writeFile(path, claudeTranscript(`/Users/me/.unmute/remote/local/${taskId}`, 'do the thing'))
    const [found] = await discoverSessions(roots)
    const record = await readSession(found!)
    assert.equal(record.unmuteTaskId, taskId)
    assert.equal(record.project, undefined, 'a uuid is never shown as a project name')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('both spellings of the Unmute scratch path resolve to the same task', () => {
  const id = '70254596-380b-4330-b0aa-dfef1979d6a4'
  assert.equal(unmuteTaskIdOf(`/Users/me/.unmute/remote/local/${id}`), id)
  assert.equal(unmuteTaskIdOf(`/Users/me/-Users-me--unmute-remote-local-${id}`), id)
  assert.equal(unmuteTaskIdOf('/Users/me/tools/unmute/unmute-cloud'), undefined)
  assert.equal(unmuteTaskIdOf(undefined), undefined)
})

/**
 * Codex writes its whole base-instructions prompt into session_meta before the
 * first turn; one real file measured 21 MB that way. A reader that parses every
 * line would spend that budget on a blob that can never be a turn.
 */
test('an oversized system blob does not hide the conversation behind it', async () => {
  const { roots, dir } = await fixture()
  try {
    const path = join(roots.codexSessions, '2026', '08', '26', 'rollout-big.jsonl')
    await fs.writeFile(path, [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'cx-big', cwd: '/Users/me/proj', base_instructions: 'x'.repeat(400 * 1024) } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Look into Palmier Pro' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'It has no MCP server.' } }),
    ].join('\n'))
    const [found] = await discoverSessions(roots)
    const record = await readSession(found!)
    assert.equal(record.opening, 'Look into Palmier Pro')
    assert.equal(record.project, 'proj')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('agent-own detection matches the slug form as well as the path', () => {
  const roots: SessionRoots = {
    claudeProjects: '/c', codexSessions: '/x', agentRuntime: '/Users/me/Library/App/unmute-agent',
  }
  assert.ok(isAgentOwnSession('/c/-Users-me-Library-App-unmute-agent/a.jsonl', roots))
  assert.ok(isAgentOwnSession('/Users/me/Library/App/unmute-agent/runtime/a.jsonl', roots))
  assert.ok(!isAgentOwnSession('/c/-Users-me-repo/a.jsonl', roots))
})

/**
 * A fifth of the recently-touched sessions on the real disk are subagent forks
 * and plan-task workers. Their opening is machine framing, so once it is
 * stripped they have none — and a digest of blank rows is worse than a shorter
 * one. They stay indexed and searchable; they are never "what you were doing".
 */
test('a subagent fork is indexed but marked derived', async () => {
  const { roots, dir } = await fixture()
  try {
    await fs.writeFile(
      join(roots.claudeProjects, '-Users-me-repo', 'fork.jsonl'),
      [
        JSON.stringify({ type: 'user', cwd: '/Users/me/repo', message: { content: [{ type: 'text', text: '<fork-boilerplate> You are a worker fork.' }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'DONE Commit: abc123' }] } }),
      ].join('\n'),
    )
    const [found] = await discoverSessions(roots)
    const record = await readSession(found!)
    assert.equal(record.derived, true)
    assert.equal(record.opening, undefined)
    assert.equal(record.closing, 'DONE Commit: abc123', 'still searchable by what it concluded')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test("the router's own classifier REPL is infrastructure, not work", async () => {
  const { roots, dir } = await fixture()
  try {
    await fs.writeFile(
      join(roots.claudeProjects, '-Users-me-repo', 'router.jsonl'),
      JSON.stringify({ type: 'user', cwd: '/Users/me/.unmute/remote/router-claude', message: { content: [{ type: 'text', text: 'classify this utterance' }] } }),
    )
    const [found] = await discoverSessions(roots)
    assert.equal((await readSession(found!)).derived, true)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('a session a person actually opened is not derived', async () => {
  const { roots, dir } = await fixture()
  try {
    await fs.writeFile(
      join(roots.claudeProjects, '-Users-me-repo', 'real.jsonl'),
      claudeTranscript('/Users/me/repo', 'Audit the billing migrations'),
    )
    const [found] = await discoverSessions(roots)
    assert.equal((await readSession(found!)).derived, undefined)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
