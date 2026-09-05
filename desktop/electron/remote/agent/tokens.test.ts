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

  const token = tokens.mint('run-a', 'ix-1', 'codex', 60_000)

  assert.deepEqual(tokens.resolve(token), {
    kind: 'unmute-agent', runId: 'run-a', interactionId: 'ix-1', provider: 'codex', expiresAt: 61_000,
  })
  assert.equal(tokens.resolve('wrong-token'), null)
})

test('stable session credential grants nothing between turns and follows only the latest live grant', () => {
  const { tokens, setNow } = createTokens()
  const credential = tokens.sessionToken('run-a', 'claude')
  assert.equal(tokens.resolve(credential), null)
  const old = tokens.mint('run-a', 'one', 'claude', 100)
  assert.equal(tokens.resolve(credential)?.interactionId, 'one')
  tokens.closeRun('run-a')
  assert.equal(tokens.resolve(credential), null)
  tokens.mint('run-a', 'two', 'claude', 100)
  assert.equal(tokens.sessionToken('run-a', 'claude'), credential)
  assert.equal(tokens.resolve(old), null)
  assert.equal(tokens.resolve(credential)?.interactionId, 'two')
  setNow(1100)
  assert.equal(tokens.resolve(credential), null)
  tokens.mint('run-a', 'three', 'codex', 100)
  assert.equal(tokens.resolve(credential), null)
  const switched = tokens.sessionToken('run-a', 'codex')
  assert.notEqual(switched, credential)
  assert.equal(tokens.resolve(switched)?.provider, 'codex')
  tokens.forgetSession('run-a')
  assert.equal(tokens.resolve(switched), null)
})

test('does not resolve a token at or after its expiry', () => {
  const { tokens, setNow } = createTokens()
  const token = tokens.mint('run-a', 'ix-1', 'claude', 60_000)

  setNow(61_000)

  assert.equal(tokens.resolve(token), null)
})

test('rotating a run invalidates its prior interaction token', () => {
  const { tokens } = createTokens()
  const first = tokens.mint('run-a', 'ix-1', 'claude', 60_000)
  const second = tokens.mint('run-a', 'ix-2', 'codex', 60_000)

  assert.equal(tokens.resolve(first), null)
  assert.equal(tokens.resolve(second)?.runId, 'run-a')
  assert.equal(tokens.resolve(second)?.interactionId, 'ix-2')
  assert.equal(tokens.resolve(second)?.provider, 'codex')
})

test('closing a run invalidates its active token', () => {
  const { tokens } = createTokens()
  const token = tokens.mint('run-a', 'ix-1', 'claude', 60_000)

  tokens.closeRun('run-a')

  assert.equal(tokens.resolve(token), null)
})

test('keeps tokens isolated between runs', () => {
  const { tokens } = createTokens()
  const runA = tokens.mint('run-a', 'ix-a', 'claude', 60_000)
  const runB = tokens.mint('run-b', 'ix-b', 'codex', 60_000)

  tokens.closeRun('run-a')

  assert.equal(tokens.resolve(runA), null)
  assert.equal(tokens.resolve(runB)?.interactionId, 'ix-b')
})

test('sweep removes expired tokens without affecting active runs', () => {
  const { tokens, setNow } = createTokens()
  const expired = tokens.mint('run-a', 'ix-a', 'claude', 1)
  const active = tokens.mint('run-b', 'ix-b', 'codex', 60_000)

  setNow(1_001)
  tokens.sweep()

  assert.equal(tokens.resolve(expired), null)
  assert.equal(tokens.resolve(active)?.runId, 'run-b')
})
