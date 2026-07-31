import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  encodeProjectDir, toTask, listTasks, findTranscript, parseTranscript,
  type ClaudeDesktopTask,
} from './sessions'

// Every shape below is copied from REAL files on a live machine — the session
// JSON from ~/Library/Application Support/Claude/claude-code-sessions, the
// transcript rows from ~/.claude/projects/*/*.jsonl. The value of this parser is
// that it matches what Claude Desktop actually writes, so inventing a plausible
// shape here would defeat the test.

const task = (over: Partial<ClaudeDesktopTask> = {}): ClaudeDesktopTask => ({
  sessionId: 'local_abc', cliSessionId: 'abc', title: null, model: null,
  cwd: '/Users/z/proj', originCwd: null, worktreePath: null, permissionMode: null,
  completedTurns: 0, createdAt: 0, lastActivityAt: 0, archived: false,
  transcriptUnavailable: false, ...over,
})

// ── encoding ──────────────────────────────────────────────────────────────

test('cwd encoding replaces / and . and _ — all three, or transcripts go missing', () => {
  // Measured: with `/` alone only 5 of 11 real transcripts resolved.
  assert.equal(encodeProjectDir('/Users/z/tools/calorify_ai/backend/calorify_ai'),
    '-Users-z-tools-calorify-ai-backend-calorify-ai')
  assert.equal(encodeProjectDir('/Users/z/.claude/jobs/d802/tmp/dl-probe'),
    '-Users-z--claude-jobs-d802-tmp-dl-probe')
})

// ── metadata ──────────────────────────────────────────────────────────────

test('a task with no sessionId is dropped — there is no safe key for it', () => {
  assert.equal(toTask({ title: 'orphan', cwd: '/x' }), null)
})

test('completedTurns absent means 0, and does NOT mean "no transcript"', () => {
  // The two real tasks that broke the old predicate: no completedTurns, no
  // transcriptUnavailable, and a transcript of 45 and 17 rows on disk.
  const t = toTask({ sessionId: 'local_94ed', cliSessionId: '94ed', cwd: '/x' })!
  assert.equal(t.completedTurns, 0)
  assert.equal(t.transcriptUnavailable, false)
})

test('listTasks walks the two uuid levels and orders by most recent activity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cds-'))
  const leaf = join(dir, 'aaaa', 'bbbb')
  await mkdir(leaf, { recursive: true })
  await writeFile(join(leaf, 'local_1.json'),
    JSON.stringify({ sessionId: 'local_1', cwd: '/a', lastActivityAt: 100 }))
  await writeFile(join(leaf, 'local_2.json'),
    JSON.stringify({ sessionId: 'local_2', cwd: '/b', lastActivityAt: 900 }))
  const got = await listTasks(dir)
  assert.deepEqual(got.map((t) => t.sessionId), ['local_2', 'local_1'])
})

test('one corrupt task file does not blank the whole list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cds-'))
  const leaf = join(dir, 'a', 'b')
  await mkdir(leaf, { recursive: true })
  await writeFile(join(leaf, 'local_ok.json'), JSON.stringify({ sessionId: 'ok', cwd: '/a' }))
  await writeFile(join(leaf, 'local_bad.json'), '{ not json')
  const got = await listTasks(dir)
  assert.deepEqual(got.map((t) => t.sessionId), ['ok'])
})

test('a missing sessions dir is empty, not a throw — Claude Desktop may never have run', async () => {
  assert.deepEqual(await listTasks(join(tmpdir(), 'does-not-exist-cds')), [])
})

// ── transcript resolution ─────────────────────────────────────────────────

test('transcriptUnavailable is honoured without touching the disk', async () => {
  const got = await findTranscript(task({ transcriptUnavailable: true }), '/nope')
  assert.equal(got, null)
})

test('no cliSessionId means no lookup handle, so no transcript', async () => {
  assert.equal(await findTranscript(task({ cliSessionId: null }), '/nope'), null)
})

test('resolves via the encoded cwd', async () => {
  const projects = await mkdtemp(join(tmpdir(), 'cdp-'))
  const d = join(projects, encodeProjectDir('/Users/z/proj'))
  await mkdir(d, { recursive: true })
  await writeFile(join(d, 'abc.jsonl'), '')
  assert.equal(await findTranscript(task(), projects), join(d, 'abc.jsonl'))
})

test('falls back to scanning when cwd moved — a task that migrated to a worktree', async () => {
  const projects = await mkdtemp(join(tmpdir(), 'cdp-'))
  // The transcript lives where the task STARTED, not where cwd now points.
  const d = join(projects, '-somewhere-else-entirely')
  await mkdir(d, { recursive: true })
  await writeFile(join(d, 'abc.jsonl'), '')
  assert.equal(await findTranscript(task({ cwd: '/Users/z/moved' }), projects),
    join(d, 'abc.jsonl'))
})

test('a task with a handle but no file yet is null, not an error', async () => {
  const projects = await mkdtemp(join(tmpdir(), 'cdp-'))
  assert.equal(await findTranscript(task(), projects), null)
})

// ── transcript parsing ────────────────────────────────────────────────────

const row = (o: Record<string, unknown>) => JSON.stringify(o)
const user = (text: string) => row({ type: 'user', message: { role: 'user', content: text } })
const assistant = (...blocks: unknown[]) =>
  row({ type: 'assistant', message: { role: 'assistant', content: blocks } })

test('a user message is a plain string, not a block list', () => {
  const s = parseTranscript(user('do the thing'))
  assert.equal(s.userMessages, 1)
  assert.deepEqual(s.turns, [{ role: 'user', text: 'do the thing' }])
})

test('thinking becomes commentary, text becomes the headline', () => {
  const s = parseTranscript([
    assistant({ type: 'thinking', thinking: 'weighing options' }),
    assistant({ type: 'text', text: 'Done.' }),
  ].join('\n'))
  assert.deepEqual(s.turns.map((t) => t.role), ['commentary', 'assistant'])
  assert.equal(s.lastAgentMessage, 'Done.')
})

test('a tool call and its result become ONE turn', () => {
  const s = parseTranscript([
    assistant({ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }),
    row({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'a.txt' },
    ] } }),
  ].join('\n'))
  assert.equal(s.turns.length, 1)
  assert.deepEqual(s.turns[0], {
    role: 'tool', text: 'Bash', title: 'Bash', code: '{"command":"ls"}',
    output: 'a.txt', ok: true,
  })
  assert.equal(s.pendingToolCalls, 0)
})

test('a tool_result row is the runtime reporting, NOT the user speaking', () => {
  // Miscounting these inflates the turn count and shows JSON as a user message.
  const s = parseTranscript([
    assistant({ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }),
    row({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'file body' },
    ] } }),
  ].join('\n'))
  assert.equal(s.userMessages, 0)
})

test('tool_result content may be a list of blocks, not a string', () => {
  const s = parseTranscript([
    assistant({ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }),
    row({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'line' }] },
    ] } }),
  ].join('\n'))
  assert.equal(s.turns[0].output, 'line')
})

test('is_error marks the step failed', () => {
  const s = parseTranscript([
    assistant({ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }),
    row({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'boom', is_error: true },
    ] } }),
  ].join('\n'))
  assert.equal(s.turns[0].ok, false)
})

test('an unmatched call is reported — a candidate blocked signal, not a verdict', () => {
  const s = parseTranscript(
    assistant({ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }))
  assert.equal(s.pendingToolCalls, 1)
  assert.equal(s.pendingToolName, 'Bash')
})

test('sidechain rows are excluded — they are a subagent, not this conversation', () => {
  const s = parseTranscript([
    user('main thread'),
    row({ type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent work' } }),
  ].join('\n'))
  assert.deepEqual(s.turns.map((t) => t.text), ['main thread'])
  assert.equal(s.userMessages, 1)
})

test('app bookkeeping rows are ignored, not guessed at', () => {
  // Real row types seen alongside the conversation on a live machine.
  const s = parseTranscript([
    row({ type: 'last-prompt' }), row({ type: 'permission-mode' }),
    row({ type: 'ai-title' }), row({ type: 'file-history-snapshot' }),
    row({ type: 'attachment' }), user('hi'),
  ].join('\n'))
  assert.equal(s.turns.length, 1)
})

test('a half-written trailing line is skipped — the file is live', () => {
  const s = parseTranscript(`${user('hi')}\n{"type":"assist`)
  assert.equal(s.turns.length, 1)
})

test('turnLimit keeps the NEWEST turns', () => {
  const s = parseTranscript([user('one'), user('two'), user('three')].join('\n'), 2)
  assert.deepEqual(s.turns.map((t) => t.text), ['two', 'three'])
  // but the count is of everything, not just what survived the window
  assert.equal(s.userMessages, 3)
})

test('updatedAt is the newest timestamp present', () => {
  const s = parseTranscript([
    row({ type: 'user', timestamp: '2026-07-30T10:00:00.000Z', message: { role: 'user', content: 'a' } }),
    row({ type: 'user', timestamp: '2026-07-30T12:00:00.000Z', message: { role: 'user', content: 'b' } }),
  ].join('\n'))
  assert.equal(s.updatedAt, Date.parse('2026-07-30T12:00:00.000Z'))
})
