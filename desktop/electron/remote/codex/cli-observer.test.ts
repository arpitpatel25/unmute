import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rollupCodexEvents, type RolloutEvent } from './cli-observer'

const NOW = '2026-08-09T12:00:00.000Z'
const ctx = (kind: 'oneoff' | 'session' = 'session') => ({ now: NOW, kind })
const ev = (type: string, payload: Record<string, unknown> = {}, ts = '2026-08-09T11:00:00.000Z'): RolloutEvent =>
  ({ type: 'event_msg', timestamp: ts, payload: { type, ...payload } })

test('a started turn with no completion is working', () => {
  const { status } = rollupCodexEvents([ev('task_started')], ctx())
  assert.equal(status!.state, 'processing')
})

test('task_complete ends the turn and keeps what it said', () => {
  const { status } = rollupCodexEvents([
    ev('task_started'),
    ev('agent_message', { message: 'Read the README.\nHere is the gist.' }),
    ev('task_complete'),
  ], ctx())
  assert.equal(status!.state, 'done')
  assert.equal(status!.result!.summary, 'Read the README.')
  assert.match(status!.result!.detail!, /Here is the gist/)
})

test('the LAST line is not the answer — accounting keeps trickling after a turn ends', () => {
  // Real rollouts end on `token_count` routinely. Reading the tail would report
  // a finished task as working for as long as the bookkeeping continued.
  const { status } = rollupCodexEvents([
    ev('task_started'),
    ev('agent_message', { message: 'Done.' }),
    ev('task_complete'),
    ev('token_count', { total: 1234 }),
    ev('thread_settings_applied'),
  ], ctx())
  assert.equal(status!.state, 'done')
})

test('tool activity is cadence, not a state change — it is what PostToolUse gives Claude', () => {
  const { status } = rollupCodexEvents([
    ev('task_started'),
    ev('patch_apply_end'),
  ], ctx())
  assert.equal(status!.state, 'processing')
  assert.equal(status!.step, 'editing files')
})

test('a step never survives the turn it described', () => {
  const { status } = rollupCodexEvents([
    ev('task_started'), ev('patch_apply_end'), ev('task_complete'),
  ], ctx())
  assert.equal(status!.step, undefined, 'a caption must not outlive its picture')
})

test('pressing Esc ends a turn — it does not break the task', () => {
  // `turn_aborted` is the ordinary way to stop a Codex turn you have seen
  // enough of. Mapping it to `failed` makes it DEMANDING, so the surface would
  // nag about every deliberate cancellation. Five of twelve real rollouts on
  // this machine end this way — 42% of ordinary endings called a failure.
  const { status } = rollupCodexEvents([ev('task_started'), ev('turn_aborted')], ctx())
  assert.equal(status!.state, 'done')
  assert.equal(status!.error, undefined, 'nothing broke')
  assert.match(status!.thread_context!, /You stopped it part-way/)
})

test('a new turn clears the previous abort', () => {
  const { status } = rollupCodexEvents([
    ev('task_started'), ev('turn_aborted'), ev('task_started'),
  ], ctx())
  assert.equal(status!.state, 'processing')
  assert.equal(status!.error, undefined)
})

test('a THREAD finishing is a checkpoint; an ERRAND finishing is the end', () => {
  const done = [ev('task_started'), ev('agent_message', { message: 'Playing.' }), ev('task_complete')]
  assert.match(rollupCodexEvents(done, ctx('session')).status!.thread_context!, /waiting for your next direction/)
  assert.match(rollupCodexEvents(done, ctx('oneoff')).status!.thread_context!, /Nothing further is expected/)
})

test('a rollout with nothing to say yields no status rather than a guess', () => {
  const { status } = rollupCodexEvents([
    { type: 'session_meta', payload: { session_id: 'x' } },
    ev('token_count'),
  ], ctx())
  assert.equal(status, null)
})

test('the heartbeat is the newest timestamp anywhere in the rollout', () => {
  const { lastActivityAt } = rollupCodexEvents([
    ev('task_started', {}, '2026-08-09T10:00:00.000Z'),
    ev('token_count', {}, '2026-08-09T11:30:00.000Z'),
  ], ctx())
  assert.equal(lastActivityAt, Date.parse('2026-08-09T11:30:00.000Z'))
})
