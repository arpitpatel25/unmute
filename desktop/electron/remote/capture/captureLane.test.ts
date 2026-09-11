import { test } from 'node:test'
import assert from 'node:assert/strict'
import { admitCapture, destinationAtSubmit, type Lane, type LiveCapture } from './captureLane'

const idle: LiveCapture | null = null
function live(lane: Lane): LiveCapture { return { lane, startedAt: 1_000 } }

test('any lane may start when nothing is live', () => {
  for (const lane of ['dictation', 'orchestrator', 'agent'] as Lane[]) {
    assert.deepEqual(admitCapture(idle, lane, 2_000), { admitted: true, capture: { lane, startedAt: 2_000 } })
  }
})

// THE FAILURE THIS PREVENTS. On 18 August the Agent key armed a capture at
// 09:58:42 and the Remote key armed another ON TOP OF IT one second later.
// Nothing stopped it, and the resulting confusion of ownership sent a Remote
// task to the Agent seventy seconds later. Exclusivity removes that at the
// input layer, before the routing question can even arise.
test('a second lane cannot start while one is live', () => {
  const result = admitCapture(live('agent'), 'orchestrator', 2_000)
  assert.equal(result.admitted, false)
  assert.equal(result.reason, 'capture-already-live')
  assert.equal(result.blockedBy, 'agent')
})

test('even the same lane cannot start twice', () => {
  assert.equal(admitCapture(live('agent'), 'agent', 2_000).admitted, false)
})

test('every lane blocks every other', () => {
  const lanes: Lane[] = ['dictation', 'orchestrator', 'agent']
  for (const held of lanes) {
    for (const wanted of lanes) {
      assert.equal(admitCapture(live(held), wanted, 2_000).admitted, false, `${held} should block ${wanted}`)
    }
  }
})

// A refusal must be observable. The bug above hid precisely because a capture
// that went nowhere left no trace — "why did nothing happen" was unanswerable
// from the logs.
test('a refusal carries what blocked it, so the log can say why', () => {
  const result = admitCapture(live('dictation'), 'agent', 2_000)
  assert.deepEqual(result, { admitted: false, reason: 'capture-already-live', blockedBy: 'dictation' })
})

test('once the live capture ends the next lane is admitted', () => {
  assert.equal(admitCapture(null, 'orchestrator', 3_000).admitted, true)
})

test('right-Option snapshots the task visible at submit, not at capture start', () => {
  assert.deepEqual(destinationAtSubmit(false, 'task-at-submit'), {
    route: 'task',
    targetTaskId: 'task-at-submit',
  })
})

test('right-Option snapshots the selected Unmute Agent card as the Agent route', () => {
  assert.deepEqual(destinationAtSubmit(true, 'stale-task-behind-agent'), {
    route: 'agent',
    targetTaskId: null,
  })
})

test('right-Option with no selected card remains an unaddressed task request', () => {
  assert.deepEqual(destinationAtSubmit(false, null), {
    route: 'task',
    targetTaskId: null,
  })
})
