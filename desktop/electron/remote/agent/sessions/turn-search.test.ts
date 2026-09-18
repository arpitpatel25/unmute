import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { searchTurnIndex, withinDistance } from './turn-search.ts'
import type { IndexedSession, IndexedTurn } from './turn-index.ts'

const DAY = 86_400_000

function id(n: number): string {
  return `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
}

async function index(turns: IndexedTurn[], sessions: Partial<IndexedSession>[] = []): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'turn-search-'))
  await fs.writeFile(join(root, 'turns.jsonl'), turns.map(turn => JSON.stringify(turn) + '\n').join(''))
  await fs.writeFile(join(root, 'sessions.jsonl'), sessions.map(session => JSON.stringify(session) + '\n').join(''))
  return root
}

function turn(session: number, t: number, text: string, o = 0): IndexedTurn {
  return { s: id(session), t, o, text }
}

/**
 * THE FIELD FAILURE, REBUILT (2026-09-18). A common word fills the front of
 * the file, and the sessions that name the person sit after it. A capped grep
 * in file order returned only the common word; this has to return the person,
 * and the most recent mention of them first.
 */
test('a name buried behind a common word is found, and the newest mention leads', async () => {
  const turns: IndexedTurn[] = []
  for (let i = 0; i < 60; i++) turns.push(turn(i, i * 1000, `open WhatsApp and send Rishi link ${i}`))
  turns.push(turn(100, 5 * DAY, 'share this with Tanmay IIT GN on WhatsApp'))
  turns.push(turn(101, 9 * DAY, 'Yes its Tanmay IIT GN'))
  const root = await index(turns)

  const result = await searchTurnIndex({ terms: ['Tanmay'] }, root)
  assert.equal(result.matchedSessions, 2)
  assert.equal(result.searched.turns, 62)
  assert.deepEqual(result.sessions.map(s => s.sessionId), [id(101), id(100)])
})

test('transcribed spellings are matched and labelled by how they matched', async () => {
  const root = await index([
    turn(1, 1, 'send it to Tanmay'),
    turn(2, 2, 'message T A N M A Y about the plan'),
    turn(3, 3, 'ask tanmayiitgn what he thinks'),
    turn(4, 4, 'ping Tanmai tomorrow'),
    turn(5, 5, 'time to go home'),
  ])
  const result = await searchTurnIndex({ terms: ['Tanmay'] }, root)
  const kinds = Object.fromEntries(result.sessions.map(s => [s.sessionId, s.match]))
  assert.equal(kinds[id(1)], 'exact')
  assert.equal(kinds[id(2)], 'joined')
  // "tanmayiitgn" contains the term once nothing separates the words.
  assert.equal(kinds[id(3)], 'exact')
  assert.equal(kinds[id(4)], 'close')
  // A short common word is not a respelling of a name.
  assert.equal(kinds[id(5)], undefined)
})

test('any term matching is enough, and the terms that matched are named', async () => {
  const root = await index([turn(1, 1, 'call Tanmay IITGN'), turn(2, 2, 'the IIT Jiyan group')])
  const result = await searchTurnIndex({ terms: ['Tanmay', 'IIT Jiyan'] }, root)
  assert.equal(result.matchedSessions, 2)
  assert.deepEqual(result.sessions.find(s => s.sessionId === id(2))?.matchedTerms, ['IIT Jiyan'])
})

test('an exact match outranks a newer respelling, and software-opened sessions come last', async () => {
  const root = await index(
    [turn(1, 1, 'Tanmay said yes'), turn(2, 10, 'Tanmai said no'), turn(3, 20, 'You are maintaining a record: Tanmay')],
    [{ id: id(3), briefing: true, provider: 'claude', provenance: 'main', path: '/x', firstAt: 20, lastAt: 20, turns: 1 }],
  )
  const result = await searchTurnIndex({ terms: ['Tanmay'] }, root)
  assert.deepEqual(result.sessions.map(s => s.sessionId), [id(1), id(2), id(3)])
  assert.equal(result.sessions[2]!.briefing, true)
})

test('a page says how many sessions are left, and the cursor reaches all of them', async () => {
  const turns = Array.from({ length: 7 }, (_, i) => turn(i, i, `Tanmay ${i}`))
  const root = await index(turns)
  const first = await searchTurnIndex({ terms: ['Tanmay'], limit: 3 }, root)
  assert.equal(first.matchedSessions, 7)
  assert.equal(first.remaining, 4)
  assert.equal(first.nextCursor, 3)
  const seen = new Set(first.sessions.map(s => s.sessionId))
  let cursor = first.nextCursor
  while (cursor !== undefined) {
    const page = await searchTurnIndex({ terms: ['Tanmay'], limit: 3, cursor }, root)
    for (const session of page.sessions) seen.add(session.sessionId)
    cursor = page.nextCursor
  }
  assert.equal(seen.size, 7)
})

test('hits are capped per session but counted, and carry the offset to read', async () => {
  const root = await index(Array.from({ length: 6 }, (_, i) => turn(1, i, `Tanmay again ${i}`, i * 100)))
  const [session] = (await searchTurnIndex({ terms: ['Tanmay'] }, root)).sessions
  assert.equal(session!.matchedTurns, 6)
  assert.equal(session!.hits.length, 3)
  assert.deepEqual(session!.hits.map(h => h.o), [500, 400, 300])
})

test('a snippet is the words around the match, not the start of an 8 KB turn', async () => {
  const text = `${'filler '.repeat(400)}send it to Tanmay IIT GN please ${'tail '.repeat(400)}`
  const root = await index([turn(1, 1, text)])
  const [session] = (await searchTurnIndex({ terms: ['Tanmay'] }, root)).sessions
  assert.match(session!.hits[0]!.snippet, /send it to Tanmay IIT GN please/)
  assert.ok(session!.hits[0]!.snippet.length < 300)
})

test('a replayed batch of hundreds of linked copies is summarised, not listed', async () => {
  const linkedTo = Array.from({ length: 400 }, (_, i) => id(1000 + i))
  const root = await index([turn(1, 1, 'Tanmay')], [
    { id: id(1), provider: 'codex', provenance: 'main', path: '/x', firstAt: 1, lastAt: 1, turns: 1, linkedTo },
  ])
  const [session] = (await searchTurnIndex({ terms: ['Tanmay'] }, root)).sessions
  assert.equal(session!.linkedTo!.length, 3)
  assert.equal(session!.linkedCount, 400)
})

test('turns appended after a search are found by the next one', async () => {
  const root = await index([turn(1, 1, 'nothing here')])
  assert.equal((await searchTurnIndex({ terms: ['Tanmay'] }, root)).matchedSessions, 0)
  await fs.appendFile(join(root, 'turns.jsonl'), JSON.stringify(turn(2, 2, 'now Tanmay')) + '\n')
  const after = await searchTurnIndex({ terms: ['Tanmay'] }, root)
  assert.equal(after.matchedSessions, 1)
  assert.equal(after.searched.turns, 2)
})

test('a half-written last line waits for the next search instead of being lost', async () => {
  const root = await index([turn(1, 1, 'first')])
  const whole = JSON.stringify(turn(2, 2, 'Tanmay arrives')) + '\n'
  await fs.appendFile(join(root, 'turns.jsonl'), whole.slice(0, 10))
  assert.equal((await searchTurnIndex({ terms: ['Tanmay'] }, root)).matchedSessions, 0)
  await fs.appendFile(join(root, 'turns.jsonl'), whole.slice(10))
  assert.equal((await searchTurnIndex({ terms: ['Tanmay'] }, root)).matchedSessions, 1)
})

test('a rewritten, shorter index is read again from the start', async () => {
  const root = await index([turn(1, 1, 'Tanmay one'), turn(2, 2, 'Tanmay two')])
  assert.equal((await searchTurnIndex({ terms: ['Tanmay'] }, root)).matchedSessions, 2)
  await fs.writeFile(join(root, 'turns.jsonl'), JSON.stringify(turn(3, 3, 'Tanmay three')) + '\n')
  const result = await searchTurnIndex({ terms: ['Tanmay'] }, root)
  assert.deepEqual(result.sessions.map(s => s.sessionId), [id(3)])
})

test('a missing index is an empty search, not an error', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'turn-search-empty-'))
  const result = await searchTurnIndex({ terms: ['Tanmay'] }, root)
  assert.equal(result.matchedSessions, 0)
  assert.equal(result.searched.turns, 0)
})

test('distance is bounded and exact', () => {
  assert.equal(withinDistance('tanmay', 'tanmai', 1), true)
  assert.equal(withinDistance('tanmay', 'tanmee', 1), false)
  assert.equal(withinDistance('onboarding', 'onbording', 2), true)
})
