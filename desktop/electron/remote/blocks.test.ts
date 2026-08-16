import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupIntoTurns, turnMetaOf, asBlock, type Block } from './blocks'

const msg = (role: 'user' | 'assistant', text: string): Block => ({ kind: 'message', role, text })
const cmd = (command: string, extra: Partial<Extract<Block, { kind: 'command' }>> = {}): Block =>
  ({ kind: 'command', label: 'Ran command', command, status: 'ok', ...extra })
const file = (path: string, added: number, removed: number): Block =>
  ({ kind: 'fileChange', path, verb: 'Edited', added, removed })

// ── the open rule ──────────────────────────────────────────────────────────
//
// An unrecognised kind must degrade to a PLAIN row, never to an assistant
// bubble. The old `default:` branch in ConversationPresentation turned anything
// unknown into an answer, which is worse than showing nothing: it is wrong
// rather than absent, and it is what stops a reader shipping a richer kind
// before the surface learns to draw it.

test('an unknown kind decodes to `unknown`, never to a message', () => {
  const b = asBlock({ kind: 'holographicDiff', payload: 42 })
  assert.equal(b.kind, 'unknown')
  assert.notEqual(b.kind, 'message')
})

test('unknown keeps the raw payload so nothing is silently lost', () => {
  const b = asBlock({ kind: 'futureThing', detail: 'x' })
  assert.equal(b.kind, 'unknown')
  assert.match((b as Extract<Block, { kind: 'unknown' }>).raw, /futureThing/)
})

test('a known kind passes through untouched', () => {
  const b = asBlock({ kind: 'message', role: 'user', text: 'hello' })
  assert.equal(b.kind, 'message')
  assert.equal((b as Extract<Block, { kind: 'message' }>).text, 'hello')
})

test('junk that is not an object at all still yields a block', () => {
  assert.equal(asBlock(null).kind, 'unknown')
  assert.equal(asBlock('nope').kind, 'unknown')
})

// ── turn grouping ──────────────────────────────────────────────────────────
//
// Consecutive non-message blocks between two messages are ONE work group, and
// each group owns its counts. A panel-level progress strip was the first draft
// and it was wrong: it described one turn while floating above all of them, so
// in a three-turn thread "4 steps" meant nothing.

test('a thread splits into one group per turn', () => {
  const turns = groupIntoTurns([
    msg('user', 'first question'),
    cmd('echo one'),
    msg('assistant', 'first answer'),
    msg('user', 'second question'),
    cmd('echo two'),
    cmd('echo three'),
    msg('assistant', 'second answer'),
  ])
  assert.equal(turns.length, 2)
  assert.equal(turns[0].work.length, 1)
  assert.equal(turns[1].work.length, 2)
})

test('each turn keeps its OWN counts — an earlier turn is not overwritten', () => {
  const turns = groupIntoTurns([
    msg('user', 'q1'), cmd('a'), file('one.ts', 3, 1), msg('assistant', 'a1'),
    msg('user', 'q2'), cmd('b'), cmd('c'), file('two.ts', 200, 11), msg('assistant', 'a2'),
  ])
  assert.deepEqual(
    { steps: turns[0].meta.steps, files: turns[0].meta.files, added: turns[0].meta.added },
    { steps: 2, files: 1, added: 3 },
  )
  assert.deepEqual(
    { steps: turns[1].meta.steps, files: turns[1].meta.files, added: turns[1].meta.added },
    { steps: 3, files: 1, added: 200 },
  )
})

test('a turn still running is marked running, and earlier ones are not', () => {
  const turns = groupIntoTurns([
    msg('user', 'q1'), cmd('a'), msg('assistant', 'a1'),
    msg('user', 'q2'), { kind: 'command', label: 'Running', command: 'sleep', status: 'running' },
  ])
  assert.equal(turns[0].meta.status, 'done')
  assert.equal(turns[1].meta.status, 'running')
})

test('a user message with no work yet still opens a turn', () => {
  const turns = groupIntoTurns([msg('user', 'just asked')])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].work.length, 0)
})

test('leading work with no user message is still grouped, not dropped', () => {
  // Rehydrated sessions can begin mid-stream — the first user turn may predate
  // whatever slice of the transcript we hold.
  const turns = groupIntoTurns([cmd('orphan'), msg('assistant', 'done')])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].work.length, 1)
})

// ── meta derivation ────────────────────────────────────────────────────────

test('file counts and line deltas sum across the turn', () => {
  const meta = turnMetaOf([file('a.ts', 10, 2), file('b.ts', 5, 3), cmd('x')])
  assert.equal(meta.files, 2)
  assert.equal(meta.added, 15)
  assert.equal(meta.removed, 5)
  assert.equal(meta.steps, 3)
})

test('a failed command makes the turn failed, not merely done', () => {
  const meta = turnMetaOf([cmd('boom', { status: 'failed', exitCode: 1 })])
  assert.equal(meta.status, 'failed')
})

test('plan progress is counted from the newest plan block', () => {
  const meta = turnMetaOf([
    { kind: 'plan', steps: [{ text: 'a', status: 'done' }, { text: 'b', status: 'todo' }] },
    { kind: 'plan', steps: [{ text: 'a', status: 'done' }, { text: 'b', status: 'done' }] },
  ])
  assert.deepEqual(meta.plan, { done: 2, total: 2 })
})

test('no plan block means no plan progress — Codex Desktop must not fake one', () => {
  assert.equal(turnMetaOf([cmd('x')]).plan, undefined)
})

test('a message block is never counted as a step', () => {
  assert.equal(turnMetaOf([msg('assistant', 'hi'), cmd('x')]).steps, 1)
})
