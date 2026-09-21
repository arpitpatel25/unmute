// Typed input and the lane keys. While an Orchestrator or Agent capture is being
// typed, the dictation key may not turn it into a paste at the cursor — and
// nothing about typing may outlive the capture it was chosen for.

import test from 'node:test'
import assert from 'node:assert/strict'
import { KeyboardManager } from './keyboard'
import type { KeyEvent } from './keyListener'
import { setRemoteTriggerEntitled, setRemoteTriggerUserPref } from './remoteTriggerGate'

interface Emitted { type: string; [k: string]: unknown }

function fresh(): { km: KeyboardManager; events: Emitted[] } {
  setRemoteTriggerEntitled(true)
  setRemoteTriggerUserPref(true)
  const km = new KeyboardManager()
  km.setActivationMode('tap-toggle')
  km.setUnmuteAgentAvailable(true)
  const events: Emitted[] = []
  km.on('keyboard', (e: Emitted) => events.push(e))
  return { km, events }
}
const key = (km: KeyboardManager, e: string) => km.handleKey(e as unknown as KeyEvent)
const fn = (km: KeyboardManager) => { key(km, 'fn-down'); key(km, 'fn-up') }
const opt = (km: KeyboardManager) => { key(km, 'right-option-down'); key(km, 'right-option-up') }
const cmdTap = (km: KeyboardManager) => { key(km, 'right-command-down'); key(km, 'right-command-up') }
const types = (events: Emitted[]) => events.map((e) => e.type).filter((t) => t !== 'key-state')

test('while typing, the dictation key cannot move the capture to the cursor', () => {
  const { km, events } = fresh()
  opt(km)
  km.setTypedInputActive(true)
  fn(km)
  assert.equal(events.some((e) => e.type === 'capture-route'), false, 'no lane switch')
  // The capture is still the Orchestrator's, so its own key still submits it.
  opt(km)
  assert.deepEqual(types(events), ['remote-start', 'remote-stop'])
})

test('while typing, Orchestrator ↔ Agent is still a free choice', () => {
  const { km, events } = fresh()
  opt(km)
  km.setTypedInputActive(true)
  cmdTap(km); cmdTap(km)
  assert.deepEqual(events.filter((e) => e.type === 'capture-route').map((e) => e.route), ['agent'])
})

test('typing ends with the capture: the next capture can be switched to the cursor again', () => {
  const { km, events } = fresh()
  opt(km)
  km.setTypedInputActive(true)
  km.resetState()          // main.ts calls this from every session ending
  // A new invocation, pressed later — not a bounce of the first tap.
  ;(km as unknown as { lastRemoteToggleTime: number }).lastRemoteToggleTime = 0
  opt(km)
  fn(km)
  assert.deepEqual(events.filter((e) => e.type === 'capture-route').map((e) => e.route), ['cursor'])
})

test('the pill’s submit ends a typed capture exactly as the trigger key would', () => {
  const { km, events } = fresh()
  cmdTap(km); cmdTap(km)
  km.setTypedInputActive(true)
  assert.equal(km.submitActiveCapture(), true)
  assert.deepEqual(types(events), ['agent-start', 'agent-stop'])
})
