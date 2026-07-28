import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  setRemoteTriggerEntitled,
  setRemoteTriggerUserPref,
  resetRemoteTriggerUserPref,
  isRemoteTriggerEnabled,
  getRemoteTriggerState,
} from './remoteTriggerGate'

beforeEach(() => {
  setRemoteTriggerEntitled(false)
  resetRemoteTriggerUserPref()
})

test('not entitled → off and locked', () => {
  assert.deepEqual(getRemoteTriggerState(), { enabled: false, locked: true })
})

test('entitled → on by default (session start), unlocked', () => {
  setRemoteTriggerEntitled(true)
  assert.deepEqual(getRemoteTriggerState(), { enabled: true, locked: false })
})

test('an entitled user can turn it off, and back on, for the session', () => {
  setRemoteTriggerEntitled(true)
  assert.equal(setRemoteTriggerUserPref(false), true)
  assert.equal(isRemoteTriggerEnabled(), false)
  assert.deepEqual(getRemoteTriggerState(), { enabled: false, locked: false })
  setRemoteTriggerUserPref(true)
  assert.equal(isRemoteTriggerEnabled(), true)
})

test('a non-entitled user cannot turn it on', () => {
  assert.equal(setRemoteTriggerUserPref(true), false)
  assert.equal(isRemoteTriggerEnabled(), false)
})

test('losing entitlement disables it even when the user had it on', () => {
  setRemoteTriggerEntitled(true)
  setRemoteTriggerUserPref(true)
  setRemoteTriggerEntitled(false)
  assert.deepEqual(getRemoteTriggerState(), { enabled: false, locked: true })
})

test('regaining entitlement restores the session choice, not the default', () => {
  setRemoteTriggerEntitled(true)
  setRemoteTriggerUserPref(false)
  setRemoteTriggerEntitled(false)
  setRemoteTriggerEntitled(true)
  assert.equal(isRemoteTriggerEnabled(), false)
})

test('reset (sign-out) returns an entitled user to the default on', () => {
  setRemoteTriggerEntitled(true)
  setRemoteTriggerUserPref(false)
  resetRemoteTriggerUserPref()
  assert.equal(isRemoteTriggerEnabled(), true)
})
