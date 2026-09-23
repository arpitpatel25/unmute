import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prefetchSessionHistory } from './history-prefetch'
import type { TurnSearchResult } from './sessions/turn-search'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const found: TurnSearchResult = {
  searched: { turns: 100, sessions: 10, unreadable: 0 }, matchedSessions: 1,
  matchedTurns: 1, remaining: 0,
  sessions: [{ sessionId: 'session-1', provider: 'codex', matchedTurns: 1, match: 'exact',
    matchedTerms: ['new models'], lastMatchAt: 10, hits: [{ t: 10, o: 42, match: 'exact',
      term: 'new models', snippet: 'The new models task was merged.' }] }],
}

test('history prefetch searches locally and returns bounded, fenced candidates', async () => {
  const queries: string[][] = []
  const result = await prefetchSessionHistory('What happened with the Codex new models task?', async input => {
    queries.push([...input.terms]); return found
  })
  assert.equal(queries.length, 1)
  assert.ok(queries[0]!.some(term => /models/i.test(term)))
  assert.equal(result.status, 'matched')
  assert.match(result.text ?? '', /session-1/)
  assert.match(result.text ?? '', /UNTRUSTED SESSION/)
  assert.ok((result.text?.length ?? 0) < 2500)
})

test('unrelated requests do not search history', async () => {
  let calls = 0
  const result = await prefetchSessionHistory('Create a pocket card for lunch', async () => { calls++; return found })
  assert.equal(result.status, 'skipped')
  assert.equal(calls, 0)
})

test('failed local lookup leaves the Agent free to use its existing tools', async () => {
  const result = await prefetchSessionHistory('Find the earlier Claude session about Vinyas', async () => { throw new Error('index unavailable') })
  assert.equal(result.status, 'error')
  assert.equal(result.text, undefined)
})

test('an empty local result may retry with terms from a lightweight helper', async () => {
  const searches: string[][] = []
  const result = await prefetchSessionHistory('Find the earlier Claude session about Vinyas',
    async input => { searches.push([...input.terms]); return searches.length === 1
      ? { ...found, matchedSessions: 0, matchedTurns: 0, sessions: [] } : found },
    async () => ['Vinyas company laptop'])
  assert.equal(searches.length, 2)
  assert.deepEqual(searches[1], ['Vinyas company laptop'])
  assert.equal(result.status, 'matched')
  assert.equal(result.helperUsed, true)
})

test('history prefetch includes a bounded concluding answer when the transcript is available', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-prefetch-'))
  try {
    const path = join(dir, 'session.jsonl')
    await writeFile(path, JSON.stringify({ type: 'event_msg', payload: {
      type: 'task_complete', last_agent_message: 'The task was merged into main.' } }) + '\n')
    const result = await prefetchSessionHistory('What happened with the Codex new models task?',
      async () => ({ ...found, sessions: [{ ...found.sessions[0]!, path }] }))
    assert.match(result.text ?? '', /The task was merged into main/)
    assert.equal(result.conclusions, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
