import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionTurnIndex, sessionIdFromPath, userTurnOf, type IndexedSession, type IndexedTurn } from './turn-index.ts'

const CLAUDE_ID = 'aaaaaaaa-1111-4222-8333-444444444444'
const CODEX_ID = '01a07379-4d6d-7de1-bb14-288a2e73b70c'

async function workspace() {
  const root = await fs.mkdtemp(join(tmpdir(), 'turn-index-'))
  const claudeProjects = join(root, 'claude', 'projects', 'proj')
  const codexSessions = join(root, 'codex', 'sessions', '2026', '09', '06')
  await fs.mkdir(claudeProjects, { recursive: true })
  await fs.mkdir(codexSessions, { recursive: true })
  return {
    root,
    roots: { claudeProjects: join(root, 'claude', 'projects'), codexSessions: join(root, 'codex', 'sessions') },
    indexRoot: join(root, 'index'),
    claudeProjects,
    codexSessions,
  }
}

function claudeUser(text: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'user', sessionId: CLAUDE_ID, isSidechain: false,
    timestamp: '2026-09-06T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...extra,
  }) + '\n'
}

function claudeAssistant(text: string) {
  return JSON.stringify({
    type: 'assistant', sessionId: CLAUDE_ID, isSidechain: false,
    timestamp: '2026-09-06T10:00:01.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n'
}

function codexMeta(source = 'vscode') {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-09-05T21:28:44.667Z',
    payload: { id: CODEX_ID, session_id: CODEX_ID, cwd: '/repo/unmute-cloud', source, originator: 'Codex Desktop' },
  }) + '\n'
}

function codexUser(text: string) {
  return JSON.stringify({
    type: 'event_msg', timestamp: '2026-09-06T11:00:00.000Z',
    payload: { type: 'user_message', message: text },
  }) + '\n'
}

async function read(path: string): Promise<string[]> {
  try { return (await fs.readFile(path, 'utf8')).split('\n').filter(Boolean) }
  catch { return [] }
}

async function turnsOf(indexRoot: string): Promise<IndexedTurn[]> {
  return (await read(join(indexRoot, 'turns.jsonl'))).map(line => JSON.parse(line))
}
async function sessionsOf(indexRoot: string): Promise<IndexedSession[]> {
  return (await read(join(indexRoot, 'sessions.jsonl'))).map(line => JSON.parse(line))
}

test('the filename is the id, in both harnesses, and only exactly', () => {
  assert.equal(sessionIdFromPath(`/x/${CLAUDE_ID}.jsonl`, 'claude'), CLAUDE_ID)
  assert.equal(sessionIdFromPath(`/x/rollout-2026-09-06T02-58-44-${CODEX_ID}.jsonl`, 'codex'), CODEX_ID)
  assert.equal(sessionIdFromPath('/x/notes.jsonl', 'claude'), null)
  assert.equal(sessionIdFromPath(`/x/${CLAUDE_ID}.jsonl`, 'codex'), null)
})

test('only what the person actually said becomes a turn', () => {
  assert.equal(userTurnOf(claudeUser('resume the astra session').trim(), 'claude', 0)?.text, 'resume the astra session')
  assert.equal(userTurnOf(claudeAssistant('done').trim(), 'claude', 0), null)
  // A tool_result rides in the user role and is not something anyone said.
  assert.equal(userTurnOf(JSON.stringify({
    type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
  }), 'claude', 0), null)
  // A subagent's prompt was written by software.
  assert.equal(userTurnOf(claudeUser('You are a reviewer', { isSidechain: true }).trim(), 'claude', 0), null)
  for (const synthetic of ['<task-notification>x', '<system-reminder>x', 'Caveat: the messages below', '<local-command-stdout>x']) {
    assert.equal(userTurnOf(claudeUser(synthetic).trim(), 'claude', 0), null, synthetic)
  }
  assert.equal(userTurnOf('{ not json', 'claude', 0), null)
})

test('both harnesses index their user turns, with provenance and cwd', async () => {
  const w = await workspace()
  await fs.writeFile(join(w.claudeProjects, `${CLAUDE_ID}.jsonl`),
    claudeUser('the pricing sheet') + claudeAssistant('opened') + claudeUser('add a row'))
  await fs.writeFile(join(w.codexSessions, `rollout-2026-09-06T02-58-44-${CODEX_ID}.jsonl`),
    codexMeta() + codexUser('build the astra branch'))

  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()

  const turns = await turnsOf(w.indexRoot)
  assert.deepEqual(turns.map(t => t.text), ['the pricing sheet', 'add a row', 'build the astra branch'])
  assert.deepEqual([...new Set(turns.map(t => t.s))], [CLAUDE_ID, CODEX_ID])
  assert.equal(turns[0]!.t, Date.parse('2026-09-06T10:00:00.000Z'))

  const sessions = await sessionsOf(w.indexRoot)
  const codex = sessions.find(s => s.id === CODEX_ID)!
  assert.equal(codex.provider, 'codex')
  assert.equal(codex.provenance, 'main')
  assert.equal(codex.cwd, '/repo/unmute-cloud')
  assert.equal(sessions.find(s => s.id === CLAUDE_ID)!.turns, 2)
})

/**
 * THE REGRESSION THIS INDEX EXISTS FOR (2026-09-06).
 *
 * `sessions_search` read 64 KB from the head of a transcript and 64 KB from the
 * tail and discarded everything between. On the real session the user was
 * looking for — 35,508,282 bytes — that was 0.369% of the file, and the
 * sentence they remembered sat at byte 30,433,728, in the discarded middle. It
 * was never read, so no query could match it and the failure was silent.
 *
 * A turn past the old window must be indexed. Anything that reintroduces a
 * read window fails here.
 */
test('a turn far past the old 128 KB window is indexed', async () => {
  const w = await workspace()
  const path = join(w.claudeProjects, `${CLAUDE_ID}.jsonl`)
  const filler = claudeAssistant('x'.repeat(4096))
  await fs.writeFile(path,
    claudeUser('opening line')
    + filler.repeat(80)                       // ≈ 330 KB, well past 128 KB
    + claudeUser('multiple sub-agents and stuff')
    + filler.repeat(10))

  assert.ok((await fs.stat(path)).size > 300_000)
  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()

  const turns = await turnsOf(w.indexRoot)
  const buried = turns.find(t => t.text.includes('multiple sub-agents'))
  assert.ok(buried, 'the buried turn was not indexed — a read window is back')
  // And the offset points at the real line, so the transcript answers the rest.
  const raw = await fs.readFile(path)
  assert.ok(raw.subarray(buried!.o).toString('utf8').startsWith('{'))
  assert.ok(raw.subarray(buried!.o, raw.indexOf(0x0a, buried!.o)).toString('utf8').includes('multiple sub-agents'))
})

/**
 * FIELD FAILURE, first live run (2026-09-07). A single line longer than one
 * 4 MB read slice made the loop break having consumed nothing, so the cursor
 * never advanced and the file stalled FOREVER — silently. 16 files were stuck
 * with 27.71 GB unread, and the worst of them was 1cc88345 itself: 405,453 of
 * 35,508,282 bytes, 20 of its 146 turns. Codex puts 21 MB of base instructions
 * on line one, so this is the common case, not the exotic one.
 *
 * An over-long line must be STEPPED OVER, and turns after it must still index.
 */
test('a line longer than one read slice does not stall the file', async () => {
  const w = await workspace()
  const path = join(w.claudeProjects, `${CLAUDE_ID}.jsonl`)
  // 5 MB on a single line — past SLICE_BYTES (4 MB), so no newline lands in
  // the first slice at all.
  const monster = JSON.stringify({
    type: 'assistant', sessionId: CLAUDE_ID, isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'text', text: 'z'.repeat(5 * 1024 * 1024) }] },
  }) + '\n'
  await fs.writeFile(path, claudeUser('before the monster') + monster + claudeUser('after the monster'))

  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()

  const texts = (await turnsOf(w.indexRoot)).map(t => t.text)
  assert.deepEqual(texts, ['before the monster', 'after the monster'],
    'a turn after an over-long line was lost — the file stalled')
})

test('an over-long line at EOF is still treated as incomplete, not skipped', async () => {
  const w = await workspace()
  const path = join(w.claudeProjects, `${CLAUDE_ID}.jsonl`)
  const whole = claudeUser('complete')
  // A 5 MB fragment with no trailing newline: still being written.
  const fragment = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'q'.repeat(5 * 1024 * 1024) }] } }).slice(0, 5 * 1024 * 1024)
  await fs.writeFile(path, whole + fragment)

  const index = new SessionTurnIndex({ roots: w.roots, root: w.indexRoot })
  await index.sync()
  assert.deepEqual((await turnsOf(w.indexRoot)).map(t => t.text), ['complete'])
})

test('appending adds only the new turns, and never re-reads the file', async () => {
  const w = await workspace()
  const path = join(w.claudeProjects, `${CLAUDE_ID}.jsonl`)
  await fs.writeFile(path, claudeUser('first'))
  const index = new SessionTurnIndex({ roots: w.roots, root: w.indexRoot })
  await index.sync()
  await fs.appendFile(path, claudeUser('second'))
  await index.sync()

  assert.deepEqual((await turnsOf(w.indexRoot)).map(t => t.text), ['first', 'second'])
  assert.equal((await sessionsOf(w.indexRoot)).find(s => s.id === CLAUDE_ID)!.turns, 2)
})

test('a half-written trailing line is left alone until it is complete', async () => {
  const w = await workspace()
  const path = join(w.claudeProjects, `${CLAUDE_ID}.jsonl`)
  const whole = claudeUser('complete turn')
  const partial = claudeUser('half written turn')
  await fs.writeFile(path, whole + partial.slice(0, 40))

  const index = new SessionTurnIndex({ roots: w.roots, root: w.indexRoot })
  await index.sync()
  assert.deepEqual((await turnsOf(w.indexRoot)).map(t => t.text), ['complete turn'])

  await fs.writeFile(path, whole + partial)
  await index.sync()
  assert.deepEqual((await turnsOf(w.indexRoot)).map(t => t.text), ['complete turn', 'half written turn'])
})

test('a file that shrank was rewritten, so it is read again from zero', async () => {
  const w = await workspace()
  const path = join(w.claudeProjects, `${CLAUDE_ID}.jsonl`)
  await fs.writeFile(path, claudeUser('original one') + claudeUser('original two'))
  const index = new SessionTurnIndex({ roots: w.roots, root: w.indexRoot })
  await index.sync()

  await fs.writeFile(path, claudeUser('compacted'))
  await index.sync()

  const texts = (await turnsOf(w.indexRoot)).map(t => t.text)
  assert.ok(texts.includes('compacted'), 'the rewritten file was not re-read')
  assert.equal((await sessionsOf(w.indexRoot)).find(s => s.id === CLAUDE_ID)!.turns, 1)
})

test('a subagent session is labelled, not dropped', async () => {
  const w = await workspace()
  await fs.writeFile(join(w.codexSessions, `rollout-2026-09-06T02-58-44-${CODEX_ID}.jsonl`),
    JSON.stringify({
      type: 'session_meta', timestamp: '2026-09-05T21:28:44.667Z',
      payload: { id: CODEX_ID, cwd: '/repo', source: { subagent: { thread_spawn: { parent_thread_id: 'parent-1' } } } },
    }) + '\n' + codexUser('review this diff'))

  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()

  const session = (await sessionsOf(w.indexRoot)).find(s => s.id === CODEX_ID)!
  assert.equal(session.provenance, 'subagent')
  assert.equal(session.parentSessionId, 'parent-1')
  // Hiding it would hide evidence; refusing to ACT on it is requireMainSession's job.
  assert.equal((await turnsOf(w.indexRoot)).length, 1)
})

test('one corrupt line does not abort the file', async () => {
  const w = await workspace()
  await fs.writeFile(join(w.claudeProjects, `${CLAUDE_ID}.jsonl`),
    claudeUser('before') + '{ this is not json\n' + claudeUser('after'))

  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()
  assert.deepEqual((await turnsOf(w.indexRoot)).map(t => t.text), ['before', 'after'])
})

test('a very long turn is clipped and says so, so the offset stays the record', async () => {
  const w = await workspace()
  await fs.writeFile(join(w.claudeProjects, `${CLAUDE_ID}.jsonl`), claudeUser('y'.repeat(20_000)))

  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()
  const [turn] = await turnsOf(w.indexRoot)
  assert.equal(turn!.trunc, true)
  assert.equal(turn!.text.length, 8 * 1024)
})

test('the index is a cache: deleting it rebuilds it exactly', async () => {
  const w = await workspace()
  await fs.writeFile(join(w.claudeProjects, `${CLAUDE_ID}.jsonl`), claudeUser('one') + claudeUser('two'))
  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()
  const before = await turnsOf(w.indexRoot)

  await fs.rm(w.indexRoot, { recursive: true, force: true })
  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()

  assert.deepEqual(await turnsOf(w.indexRoot), before)
})
