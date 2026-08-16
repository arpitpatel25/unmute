import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentTokenStore } from './tokens.ts'

function createTokens() {
  let now = 1_000
  let serial = 0
  const tokens = new AgentTokenStore({
    now: () => now,
    randomToken: () => `t-${++serial}`,
  })

  return {
    tokens,
    setNow(value: number) { now = value },
  }
}

test('mints a token that resolves to its active interaction principal', () => {
  const { tokens } = createTokens()

  const token = tokens.mint('run-a', 'ix-1', 60_000)

  assert.deepEqual(tokens.resolve(token), {
    kind: 'unmute-agent', runId: 'run-a', interactionId: 'ix-1', expiresAt: 61_000,
  })
  assert.equal(tokens.resolve('wrong-token'), null)
})

test('does not resolve a token at or after its expiry', () => {
  const { tokens, setNow } = createTokens()
  const token = tokens.mint('run-a', 'ix-1', 60_000)

  setNow(61_000)

  assert.equal(tokens.resolve(token), null)
})

test('rotating a run invalidates its prior interaction token', () => {
  const { tokens } = createTokens()
  const first = tokens.mint('run-a', 'ix-1', 60_000)
  const second = tokens.mint('run-a', 'ix-2', 60_000)

  assert.equal(tokens.resolve(first), null)
  assert.equal(tokens.resolve(second)?.runId, 'run-a')
  assert.equal(tokens.resolve(second)?.interactionId, 'ix-2')
})

test('closing a run invalidates its active token', () => {
  const { tokens } = createTokens()
  const token = tokens.mint('run-a', 'ix-1', 60_000)

  tokens.closeRun('run-a')

  assert.equal(tokens.resolve(token), null)
})

test('keeps tokens isolated between runs', () => {
  const { tokens } = createTokens()
  const runA = tokens.mint('run-a', 'ix-a', 60_000)
  const runB = tokens.mint('run-b', 'ix-b', 60_000)

  tokens.closeRun('run-a')

  assert.equal(tokens.resolve(runA), null)
  assert.equal(tokens.resolve(runB)?.interactionId, 'ix-b')
})

test('sweep removes expired tokens without affecting active runs', () => {
  const { tokens, setNow } = createTokens()
  const expired = tokens.mint('run-a', 'ix-a', 1)
  const active = tokens.mint('run-b', 'ix-b', 60_000)

  setNow(1_001)
  tokens.sweep()

  assert.equal(tokens.resolve(expired), null)
  assert.equal(tokens.resolve(active)?.runId, 'run-b')
})
