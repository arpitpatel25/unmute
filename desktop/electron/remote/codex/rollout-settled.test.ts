import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rolloutOutcome } from './rollout-settled'

const started = (n: number) => JSON.stringify({ ordinal: n, type: 'event_msg', payload: { type: 'task_started' } })
const complete = (n: number, message: string) =>
  JSON.stringify({ ordinal: n, timestamp: '2026-09-09T17:58:35.908Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: message } })
const noise = (n: number) => JSON.stringify({ ordinal: n, type: 'event_msg', payload: { type: 'token_count' } })

async function rollout(lines: string[]): Promise<{ path: string, cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'rollout-settled-'))
  const path = join(dir, 'rollout.jsonl')
  await writeFile(path, lines.join('\n') + '\n')
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('a turn that closed reports settled with its final message', async () => {
  const { path, cleanup } = await rollout([started(1), noise(2), complete(3, 'All 244 tests pass.')])
  try {
    assert.deepEqual(await rolloutOutcome(path), { settled: true, lastAgentMessage: 'All 244 tests pass.', at: '2026-09-09T17:58:35.908Z' })
  } finally { await cleanup() }
})

test('a turn still open after the last completion reports unsettled', async () => {
  const { path, cleanup } = await rollout([started(1), complete(2, 'done'), started(3), noise(4)])
  try {
    assert.equal((await rolloutOutcome(path))?.settled, false)
  } finally { await cleanup() }
})

test('trailing bookkeeping after the completion does not reopen the turn', async () => {
  const { path, cleanup } = await rollout([started(1), complete(2, 'done'), noise(3), noise(4)])
  try {
    assert.equal((await rolloutOutcome(path))?.settled, true)
  } finally { await cleanup() }
})

test('a rollout with no turn marker in reach reports unknown rather than guessing', async () => {
  const { path, cleanup } = await rollout([noise(1), noise(2)])
  try {
    assert.equal(await rolloutOutcome(path), null)
  } finally { await cleanup() }
})

test('a missing rollout reports unknown', async () => {
  assert.equal(await rolloutOutcome(join(tmpdir(), `absent-${Date.now()}.jsonl`)), null)
})

test('only the tail is read, so a huge rollout is never loaded whole', async () => {
  // A real rollout was measured at 26GB. The marker here sits before far more
  // padding than the tail window, so finding it would prove an unbounded read.
  const padding = Array.from({ length: 4000 }, (_, i) => noise(i + 10))
  const { path, cleanup } = await rollout([started(1), complete(2, 'buried'), ...padding])
  try {
    assert.equal(await rolloutOutcome(path, 8 * 1024), null)
  } finally { await cleanup() }
})

test('a line torn by the tail window boundary is skipped, not thrown on', async () => {
  const long = JSON.stringify({ ordinal: 1, type: 'event_msg', payload: { type: 'task_started', pad: 'x'.repeat(500) } })
  const last = complete(2, 'survived')
  const { path, cleanup } = await rollout([long, last])
  try {
    // Window covers all of the final line plus a fragment of the one before it,
    // so the first line in the window is invalid JSON. It must be skipped and
    // the intact completion still found.
    const outcome = await rolloutOutcome(path, Buffer.byteLength(last) + 21)
    assert.deepEqual(outcome, { settled: true, lastAgentMessage: 'survived', at: '2026-09-09T17:58:35.908Z' })
  } finally { await cleanup() }
})
