import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextCaptureAddress, type CaptureAddress } from './captureAddress'

function fold(events: Array<Parameters<typeof nextCaptureAddress>[1]>): CaptureAddress {
  return events.reduce<CaptureAddress>((address, event) => nextCaptureAddress(address, event), 'task')
}

test('the agent key addresses the utterance at the Agent', () => {
  assert.equal(fold(['agent-start']), 'agent')
})

test('the remote key addresses it at a task', () => {
  assert.equal(fold(['remote-start']), 'task')
})

// THE FIELD BUG (2026-08-18). The address was set on the Agent key-down but
// cleared only by a dispatch that completed. An Agent capture cancelled a
// second after it began therefore left the flag set, and EVERY later Remote
// press was silently readdressed to the Agent — including one whose reply
// arrived twelve seconds later looking like a fresh Agent turn.
//
// The owner of the address is the key-down, not the dispatch. Each capture
// states its own, so no earlier capture can speak for it.
test('an Agent capture that never dispatched cannot address the next one', () => {
  assert.equal(fold(['agent-start', 'remote-start']), 'task',
    'a cancelled Agent capture must not capture the following Remote press')
})

test('the address survives its own capture through to dispatch', () => {
  assert.equal(fold(['agent-start', 'dispatched']), 'task', 'and is spent once used')
  assert.equal(nextCaptureAddress('agent', 'dispatched'), 'task')
})

test('pressing the Agent key twice still addresses the Agent', () => {
  assert.equal(fold(['agent-start', 'agent-start']), 'agent')
})

test('a Remote press after a completed Agent turn stays with the task', () => {
  assert.equal(fold(['agent-start', 'dispatched', 'remote-start']), 'task')
})

// Dictation runs on its own path and never dispatches to a task, so it must
// leave a pending Agent address alone rather than quietly stealing it.
test('dictation does not disturb a pending address', () => {
  assert.equal(fold(['agent-start', 'dictation-start']), 'agent')
})
