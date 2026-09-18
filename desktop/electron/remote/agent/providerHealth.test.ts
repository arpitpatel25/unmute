import assert from 'node:assert/strict'
import test from 'node:test'

import { PROVIDER_COOLDOWN_MS, ProviderHealth } from './providerHealth'

/** A clock the tests move by hand — no sleeping, no real timers. */
function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

test('a provider that has not failed is usable, and preferred stays first', () => {
  const health = new ProviderHealth()
  assert.equal(health.isUsable('codex'), true)
  assert.deepEqual(health.order('codex'), ['codex'])
  assert.deepEqual(health.order('claude'), ['claude'])
})

test('a provider failure never silently routes work to another provider', () => {
  const health = new ProviderHealth()
  health.markFailed('codex')
  assert.equal(health.isUsable('codex'), false)
  assert.deepEqual(health.order('codex'), ['codex'])
})

test('the cooldown lapses on its own and the preferred provider resumes', () => {
  const c = clock()
  const health = new ProviderHealth(c.now)
  health.markFailed('codex')

  c.advance(PROVIDER_COOLDOWN_MS - 1)
  assert.equal(health.isUsable('codex'), false, 'still cooling down one ms before the window ends')

  c.advance(1)
  assert.equal(health.isUsable('codex'), true, 'usable again the moment the window elapses')
  assert.deepEqual(health.order('codex'), ['codex'], 'and remains the only selected provider')
})

test('a success clears the cooldown early', () => {
  const health = new ProviderHealth()
  health.markFailed('claude')
  assert.equal(health.isUsable('claude'), false)
  health.markWorking('claude')
  assert.equal(health.isUsable('claude'), true)
})

test('with both providers cooling down, the preferred one is still attempted', () => {
  // Falling back to "nothing" would strand the caller with no provider at all.
  // Attempting the user's own choice is the least surprising failure.
  const health = new ProviderHealth()
  health.markFailed('codex')
  health.markFailed('claude')
  assert.deepEqual(health.order('codex'), ['codex'])
  assert.deepEqual(health.order('claude'), ['claude'])
})

test('a CLI that is not installed is never fallen back to', () => {
  const health = new ProviderHealth()
  health.markFailed('codex')
  // Only codex on this machine: there is nothing to fall back to, so the
  // request must still be attempted rather than routed to a missing binary.
  assert.deepEqual(health.order('codex', (id) => id === 'codex'), ['codex'])
})

test('an uninstalled preferred provider remains selected and fails visibly', () => {
  const health = new ProviderHealth()
  assert.deepEqual(health.order('codex', (id) => id === 'claude'), ['codex'])
})

test('the snapshot reports the cooldown deadline for the UI, and drops it once lapsed', () => {
  const c = clock()
  const health = new ProviderHealth(c.now)
  health.markFailed('codex')

  const cooling = health.snapshot().find((s) => s.provider === 'codex')
  assert.equal(cooling?.until, c.now() + PROVIDER_COOLDOWN_MS)
  assert.equal(health.snapshot().find((s) => s.provider === 'claude')?.until, undefined)

  c.advance(PROVIDER_COOLDOWN_MS)
  assert.equal(health.snapshot().find((s) => s.provider === 'codex')?.until, undefined)
})

test('the cooldown is hours, not minutes — a spent allowance outlives a short window', () => {
  assert.ok(PROVIDER_COOLDOWN_MS >= 60 * 60_000, 'at least an hour')
})

test('with switching allowed, installed usable providers follow the chosen one', async () => {
  const { ProviderHealth } = await import('./providerHealth')
  const h = new ProviderHealth(() => 0)
  assert.deepEqual(h.order('claude', () => true), ['claude'], 'still the chosen one alone by default')
  assert.deepEqual(h.order('claude', () => true, true), ['claude', 'codex'])
  assert.deepEqual(h.order('claude', p => p === 'claude', true), ['claude'], 'never an uninstalled one')
  h.markFailed('claude')
  assert.deepEqual(h.order('claude', () => true, true), ['codex', 'claude'], 'a cooling-down choice goes last')
})
