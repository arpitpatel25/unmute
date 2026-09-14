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

/**
 * FIELD FAILURE, third live run (2026-09-07). Codex writes a user turn TWO
 * ways: `event_msg` with payload.type "user_message", and `response_item` with
 * payload.type "message" and role "user", whose blocks are `input_text` rather
 * than `text`. Only the first was indexed, so a 580 MB rollout holding 142
 * real turns reported ZERO — and a coverage audit that recounted with the same
 * wrong rule happily agreed with it.
 */
test('a Codex response_item user message is a turn, input_text blocks and all', () => {
  const record = JSON.stringify({
    type: 'response_item', timestamp: '2026-09-06T11:00:00.000Z',
    payload: { type: 'message', id: 'x', role: 'user', content: [{ type: 'input_text', text: 'go through the repo and tell me your take' }] },
  })
  assert.equal(userTurnOf(record, 'codex', 0)?.text, 'go through the repo and tell me your take')
})

test('the assistant and developer roles are not user turns', () => {
  for (const role of ['assistant', 'developer']) {
    const record = JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role, content: [{ type: 'input_text', text: 'not the user' }] },
    })
    assert.equal(userTurnOf(record, 'codex', 0), null, role)
  }
})

test('environment injections in the user role are not turns', () => {
  const synthetic = [
    '<environment_context>\n  <cwd>/Users/x</cwd>\n</environment_context>',
    '# AGENTS.md instructions for /Users/x',
    '<recommended_plugins> here is a list',
    '[Request interrupted by user]',
    'This session is being continued from a previous conversation',
  ]
  for (const text of synthetic) {
    const record = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
    assert.equal(userTurnOf(record, 'codex', 0), null, text.slice(0, 30))
  }
})

test('an attached image is stripped but the words with it are kept', () => {
  const withImage = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<image name=[Image #1] path="/var/folders/x.png">fix the corner of this' }] },
  })
  assert.equal(userTurnOf(withImage, 'codex', 0)?.text, 'fix the corner of this')
  // Several attachments, opening and closing tags, then the words.
  const multi = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '</image>\n<image name=[Image #2] path="/var/x.png">look at these two' }] },
  })
  assert.equal(userTurnOf(multi, 'codex', 0)?.text, 'look at these two')
  // An image on its own carries no words, so it is not a turn.
  const onlyImage = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<image name=[Image #1] path="/var/folders/x.png">' }] },
  })
  assert.equal(userTurnOf(onlyImage, 'codex', 0), null)
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
  // Past SLICE_BYTES (24 MB), so no newline lands in the first slice at all.
  const monster = JSON.stringify({
    type: 'assistant', sessionId: CLAUDE_ID, isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'text', text: 'z'.repeat(26 * 1024 * 1024) }] },
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
  // A 26 MB fragment with no trailing newline: still being written.
  const fragment = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'q'.repeat(26 * 1024 * 1024) }] } }).slice(0, 26 * 1024 * 1024)
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

/**
 * FIELD FAILURE, second live run (2026-09-07). A 2 MB line cap dropped a real
 * 6,474-character message whose JSON line was 6.98 MB, because Claude embeds
 * pasted images as base64 INSIDE the user turn (52 image blocks in that one
 * session). The turn vanished from the index entirely — silently, again.
 *
 * What someone said must survive whatever they attached to it.
 */
test('a user turn survives a multi-megabyte image blob on its line', async () => {
  const w = await workspace()
  const said = 'here is the screenshot, fix the thing in the corner'
  const fat = JSON.stringify({
    type: 'user', sessionId: CLAUDE_ID, isSidechain: false,
    timestamp: '2026-09-06T10:00:00.000Z',
    message: { role: 'user', content: [
      { type: 'text', text: said },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(6 * 1024 * 1024) } },
    ] },
  }) + '\n'
  const path = join(w.claudeProjects, `${CLAUDE_ID}.jsonl`)
  await fs.writeFile(path, claudeUser('before') + fat + claudeUser('after'))
  assert.ok((await fs.stat(path)).size > 6 * 1024 * 1024)

  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()

  const texts = (await turnsOf(w.indexRoot)).map(t => t.text)
  assert.deepEqual(texts, ['before', said, 'after'],
    'a real message was dropped because an image shared its line')
})

/** The blob the size cap used to be aimed at: excluded by the marker instead,
 *  so it is never parsed, and the turns around it still index. */
test("a Codex base-instructions blob is skipped without touching its file's turns", async () => {
  const w = await workspace()
  const blob = JSON.stringify({
    type: 'session_meta', timestamp: '2026-09-05T21:28:44.667Z',
    payload: { id: CODEX_ID, cwd: '/repo', source: 'vscode', instructions: 'You are Codex. '.repeat(400_000) },
  }) + '\n'
  const path = join(w.codexSessions, `rollout-2026-09-06T02-58-44-${CODEX_ID}.jsonl`)
  await fs.writeFile(path, blob + codexUser('build the astra branch'))
  assert.ok((await fs.stat(path)).size > 5 * 1024 * 1024)

  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()
  assert.deepEqual((await turnsOf(w.indexRoot)).map(t => t.text), ['build the astra branch'])
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

/**
 * 17% of the first full index was machine-written briefings — 2,703 turns of
 * one Unmute job prompt alone. They are labelled, not dropped: the same words
 * could be something a person typed, and the doctrine settled in the
 * 2026-08-26 spec is that a briefing stays searchable but is never offered as
 * work the person was doing.
 */
test('a session opened by software is labelled a briefing, and still indexed', async () => {
  const w = await workspace()
  await fs.writeFile(join(w.claudeProjects, `${CLAUDE_ID}.jsonl`),
    claudeUser('You are maintaining a factual record of one coding session so its owner can find it again')
    + claudeUser('and then some more of the job'))
  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()

  const session = (await sessionsOf(w.indexRoot)).find(s => s.id === CLAUDE_ID)!
  assert.equal(session.briefing, true)
  assert.equal((await turnsOf(w.indexRoot)).length, 2, 'a briefing must stay searchable, not be dropped')
})

test('a person opening with ordinary words is not a briefing', async () => {
  const w = await workspace()
  await fs.writeFile(join(w.claudeProjects, `${CLAUDE_ID}.jsonl`), claudeUser('you are going to love this bug'))
  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()
  const session = (await sessionsOf(w.indexRoot)).find(s => s.id === CLAUDE_ID)!
  assert.equal(session.briefing, undefined)
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

/**
 * FIELD FAILURE (2026-09-07). Codex records EVERY user message in both of its
 * shapes at the identical timestamp. Indexing both — which is what it took to
 * stop losing half of Codex — doubled every Codex turn: 4,748 of 10,107 rows,
 * 47%. It inflated turn counts, and turn counts are how a reader judges which
 * of two sessions the work is in; it is what made one thread read as two.
 */
test('the same message in both Codex shapes is one turn, not two', async () => {
  const w = await workspace()
  const stamp = '2026-09-06T11:00:00.000Z'
  const said = 'I have an idea for a job listing site that only lists official company postings'
  const both =
    JSON.stringify({ type: 'event_msg', timestamp: stamp, payload: { type: 'user_message', message: said } }) + '\n'
    + JSON.stringify({ type: 'response_item', timestamp: stamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: said }] } }) + '\n'
  await fs.writeFile(join(w.codexSessions, `rollout-2026-09-06T02-58-44-${CODEX_ID}.jsonl`), codexMeta() + both)

  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()
  assert.deepEqual((await turnsOf(w.indexRoot)).map(t => t.text), [said])
})

/** The timestamp is what makes dedupe safe: saying the same short thing twice
 *  a moment apart is genuinely two turns, and must survive. */
test('the same words said again later are two turns', async () => {
  const w = await workspace()
  const twice =
    JSON.stringify({ type: 'event_msg', timestamp: '2026-09-06T11:00:00.000Z', payload: { type: 'user_message', message: 'yes' } }) + '\n'
    + JSON.stringify({ type: 'event_msg', timestamp: '2026-09-06T11:04:00.000Z', payload: { type: 'user_message', message: 'yes' } }) + '\n'
  await fs.writeFile(join(w.codexSessions, `rollout-2026-09-06T02-58-44-${CODEX_ID}.jsonl`), codexMeta() + twice)

  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()
  assert.equal((await turnsOf(w.indexRoot)).length, 2)
})

/**
 * 679 Codex sessions open with a turn byte-identical to a Claude session's,
 * arriving in bursts of 30-50 in the same second. Unlinked, they read as two
 * separate conversations about one subject — which is exactly how a reader
 * concludes somebody started the same thing twice.
 */
test('a conversation copied into another harness is linked, and neither side ranked', async () => {
  const w = await workspace()
  const opening = 'I have an idea for a job listing site that only includes jobs posted on official company websites'
  await fs.writeFile(join(w.claudeProjects, `${CLAUDE_ID}.jsonl`), claudeUser(opening))
  await fs.writeFile(join(w.codexSessions, `rollout-2026-09-06T02-58-44-${CODEX_ID}.jsonl`), codexMeta() + codexUser(opening))

  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()
  const sessions = await sessionsOf(w.indexRoot)
  const claude = sessions.find(s => s.id === CLAUDE_ID)!
  const codex = sessions.find(s => s.id === CODEX_ID)!
  // Recorded on BOTH sides: neither is declared the original, because copies
  // are not reliably newer — measured ones predate their counterpart by 232h.
  assert.deepEqual(claude.linkedTo, [CODEX_ID])
  assert.deepEqual(codex.linkedTo, [CLAUDE_ID])
})

test('a short opening is not evidence of a copy', async () => {
  const w = await workspace()
  await fs.writeFile(join(w.claudeProjects, `${CLAUDE_ID}.jsonl`), claudeUser('carry on'))
  await fs.writeFile(join(w.codexSessions, `rollout-2026-09-06T02-58-44-${CODEX_ID}.jsonl`), codexMeta() + codexUser('carry on'))

  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()
  for (const s of await sessionsOf(w.indexRoot)) assert.equal(s.linkedTo, undefined, s.id)
})

test('two sessions in the SAME harness with one opening are not a cross-harness copy', async () => {
  const w = await workspace()
  const opening = 'I have an idea for a job listing site that only includes jobs posted on official company websites'
  const other = 'bbbbbbbb-2222-4333-8444-555555555555'
  await fs.writeFile(join(w.claudeProjects, `${CLAUDE_ID}.jsonl`), claudeUser(opening))
  await fs.writeFile(join(w.claudeProjects, `${other}.jsonl`),
    JSON.stringify({ type: 'user', sessionId: other, isSidechain: false, timestamp: '2026-09-06T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: opening }] } }) + '\n')

  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()
  for (const s of await sessionsOf(w.indexRoot)) assert.equal(s.linkedTo, undefined, s.id)
})

/**
 * FIELD FAILURE, live run 2026-09-07. A three-turn Claude session weighed
 * against its Codex copy carried a turn that was really the superpowers skill
 * body — 8,192 characters of it, truncated at the cap. Turn counts are how a
 * reader judges which side of a linked pair the work went to, so a skill load
 * counted as something the person said tilts exactly the decision this index
 * exists to inform. 92 of them on that machine, every one at the size cap.
 */
test('a skill body pasted into the user role is not something a person said', () => {
  const skill = 'Base directory for this skill: /Users/x/.claude/plugins/cache/superpowers/6.3.0\n\nname: using-superpowers'
  assert.equal(userTurnOf(claudeUser(skill).trim(), 'claude', 0), null)
  assert.equal(userTurnOf(claudeUser('▐▛███▜▌   Claude Code v2.1.207').trim(), 'claude', 0), null)
  // The words alone, from a person, are still a turn: only the harness's
  // fixed preamble is the signature.
  assert.equal(
    userTurnOf(claudeUser('which base directory does this skill live in?').trim(), 'claude', 0)?.text,
    'which base directory does this skill live in?')
})

/**
 * FIELD FAILURE, live run 2026-09-07. firstAt and lastAt were both the file's
 * mtime, so firstAt was a duplicate of lastAt on 4,006 of 4,007 sessions —
 * 565 of the 566 multi-turn ones — and on 402 neither bracketed the turns it
 * claimed to. "When did we start this" had no answer while the answer sat in
 * the turns already parsed.
 */
test('a session is bracketed by its turns, not by when the file was touched', async () => {
  const w = await workspace()
  const path = join(w.claudeProjects, `${CLAUDE_ID}.jsonl`)
  const at = (t: string, text: string) => claudeUser(text, { timestamp: t })
  await fs.writeFile(path, at('2026-09-06T02:36:04.000Z', 'I have an idea for a job listing site')
    + claudeAssistant('tell me more')
    + at('2026-09-06T02:41:11.000Z', 'the answer is all the pain points, trust is one'))
  // Touched well after the last thing anyone said — an assistant working on
  // alone is what mtime measures, and it is not where the conversation is.
  const later = new Date('2026-09-06T06:00:00.000Z')
  await fs.utimes(path, later, later)

  const index = new SessionTurnIndex({ roots: w.roots, root: w.indexRoot })
  await index.sync()
  const session = (await sessionsOf(w.indexRoot)).find(s => s.id === CLAUDE_ID)!
  assert.equal(session.turns, 2)
  assert.equal(session.firstAt, Date.parse('2026-09-06T02:36:04.000Z'))
  assert.equal(session.lastAt, Date.parse('2026-09-06T02:41:11.000Z'))
  assert.notEqual(session.firstAt, session.lastAt)

  // A later append moves lastAt and leaves firstAt on the opening turn.
  await fs.appendFile(path, at('2026-09-06T20:21:42.000Z', "let's keep going on the job listing platform"))
  await index.sync()
  const after = (await sessionsOf(w.indexRoot)).find(s => s.id === CLAUDE_ID)!
  assert.equal(after.turns, 3)
  assert.equal(after.firstAt, Date.parse('2026-09-06T02:36:04.000Z'))
  assert.equal(after.lastAt, Date.parse('2026-09-06T20:21:42.000Z'))
})

/**
 * WHICH OF TWO SESSIONS DID THEY ACTUALLY ACCEPT.
 *
 * Six real sessions all say "edit the video in Palmier Pro". Words cannot
 * separate them, and the failed one is usually the MORE recent, because the
 * failure is what made them ask again. What separates them is whether the
 * person came back: 72237a27 ran nine turns and was returned to the next day;
 * 01a03a0d said two things in the same minute and was never opened again.
 */
test('leaving a session and coming back to it is recorded; one burst is not', async () => {
  const w = await workspace()
  const at = (t: string, text: string) => claudeUser(text, { timestamp: t })
  const burst = 'bbbbbbbb-2222-4333-8444-555555555555'
  await fs.writeFile(join(w.claudeProjects, `${CLAUDE_ID}.jsonl`),
    at('2026-09-06T23:48:00.000Z', 'edit the unmute capture video in palmier pro')
    + at('2026-09-06T23:52:00.000Z', 'add the logo in the corner')
    // Next day — they left and came back. This is the signal.
    + at('2026-09-07T01:10:00.000Z', 'do you think we should trim it down'))
  await fs.writeFile(join(w.claudeProjects, `${burst}.jsonl`),
    JSON.stringify({ type: 'user', sessionId: burst, isSidechain: false, timestamp: '2026-09-06T23:22:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'lets continue editing the video from yesterday' }] } }) + '\n'
    + JSON.stringify({ type: 'user', sessionId: burst, isSidechain: false, timestamp: '2026-09-06T23:24:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'ok never mind' }] } }) + '\n')

  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()
  const sessions = await sessionsOf(w.indexRoot)
  assert.equal(sessions.find(s => s.id === CLAUDE_ID)!.returns, 1)
  // Two turns four minutes apart is one sitting, not a return.
  assert.equal(sessions.find(s => s.id === burst)!.returns, undefined)
})

/**
 * Guards against the self-feeding loop the manifest exists to avoid: a
 * routine's own run directory must never look like a main conversation, no
 * matter what its transcript's opening line says.
 */
test('a session whose cwd is a routine run gets provenance routine', async () => {
  const w = await workspace()
  await fs.writeFile(join(w.claudeProjects, `${CLAUDE_ID}.jsonl`),
    claudeUser('daily standup summary', { cwd: '/Users/me/.unmute/unmute-agent/routines/runs/2026-09-14T09-00-00' }))

  await new SessionTurnIndex({ roots: w.roots, root: w.indexRoot }).sync()

  const session = (await sessionsOf(w.indexRoot)).find(s => s.id === CLAUDE_ID)!
  assert.equal(session.provenance, 'routine')
  assert.equal(session.cwd, '/Users/me/.unmute/unmute-agent/routines/runs/2026-09-14T09-00-00')
})

test('a session tailed a day later counts the gap across the two passes', async () => {
  const w = await workspace()
  const path = join(w.claudeProjects, `${CLAUDE_ID}.jsonl`)
  const at = (t: string, text: string) => claudeUser(text, { timestamp: t })
  await fs.writeFile(path, at('2026-09-06T10:00:00.000Z', 'start the wedding video edit'))
  const index = new SessionTurnIndex({ roots: w.roots, root: w.indexRoot })
  await index.sync()
  assert.equal((await sessionsOf(w.indexRoot)).find(s => s.id === CLAUDE_ID)!.returns, undefined)

  // They come back the next day. The gap sits BETWEEN passes, which is exactly
  // where a per-pass counter would lose it — and is the strongest case there is.
  await fs.appendFile(path, at('2026-09-07T09:00:00.000Z', 'pick that back up'))
  await index.sync()
  assert.equal((await sessionsOf(w.indexRoot)).find(s => s.id === CLAUDE_ID)!.returns, 1)
})

test('Unmute talking to itself is never indexed, and is dropped if it already was', async () => {
  const w = await workspace()
  const index = new SessionTurnIndex({ roots: w.roots, root: w.indexRoot })
  await fs.writeFile(join(w.claudeProjects, `${CLAUDE_ID}.jsonl`),
    JSON.stringify({ type: 'user', cwd: '/Users/x/.unmute/remote/router-headless', sessionId: CLAUDE_ID, message: { role: 'user', content: 'Spoken command: "message Tanmay"' } }) + '\n')
  const real = 'bbbbbbbb-2222-4333-8444-555555555555'
  await fs.writeFile(join(w.claudeProjects, `${real}.jsonl`),
    JSON.stringify({ type: 'user', cwd: '/Users/x/tools/unmute', sessionId: real, message: { role: 'user', content: 'message Tanmay on WhatsApp' } }) + '\n')
  await index.sync()

  const sessions = (await fs.readFile(join(w.indexRoot, 'sessions.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l) as IndexedSession)
  assert.deepEqual(sessions.map(s => s.id), [real])
  const turns = (await fs.readFile(join(w.indexRoot, 'turns.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l) as IndexedTurn)
  assert.deepEqual(turns.map(t => t.s), [real])

  // And an index written by an older version is compacted on the next pass.
  await fs.appendFile(join(w.indexRoot, 'turns.jsonl'), JSON.stringify({ s: CLAUDE_ID, t: 1, o: 0, text: 'Spoken command: "message Tanmay"' }) + '\n')
  await fs.appendFile(join(w.indexRoot, 'sessions.jsonl'), JSON.stringify({ id: CLAUDE_ID, provider: 'claude', cwd: '/Users/x/.unmute/remote/router-headless', provenance: 'main', path: '/x', firstAt: 1, lastAt: 1, turns: 1 }) + '\n')
  const reopened = new SessionTurnIndex({ roots: w.roots, root: w.indexRoot })
  await reopened.sync()
  const after = (await fs.readFile(join(w.indexRoot, 'turns.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l) as IndexedTurn)
  assert.deepEqual(after.map(t => t.s), [real])
})
