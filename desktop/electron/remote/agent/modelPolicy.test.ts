import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { agentFallbackModels, agentModel, agentModelChain, agentModelLabel, markModelUnavailable, markModelWorking, MODEL_COOLDOWN_MS, setAgentModelChoices } from './modelPolicy'

beforeEach(() => { setAgentModelChoices({}); markModelWorking('codex', 'gpt-5.6-sol'); markModelWorking('codex', 'gpt-6-astra') })

test('out of the box: the built-in default, then a small static fallback', () => {
  assert.equal(agentModel('codex'), 'gpt-5.6-sol')
  assert.deepEqual(agentFallbackModels('codex'), ['gpt-5.5'])
  assert.equal(agentModel('claude'), 'opus')
  assert.equal(agentModelLabel('codex'), 'GPT-5.6 Sol')
})

test('the user default comes first, then the rest of the live catalog in its order', () => {
  setAgentModelChoices({ codex: { model: 'gpt-5.6-terra', fallbacks: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5'], labels: { 'gpt-5.6-terra': 'GPT-5.6-Terra' } } })
  assert.deepEqual(agentModelChain('codex'), ['gpt-5.6-terra', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5'])
  assert.equal(agentModelLabel('codex'), 'GPT-5.6-Terra')
})

test('an unavailable model is skipped for a while, then tried first again', () => {
  setAgentModelChoices({ codex: { fallbacks: ['gpt-6-astra', 'gpt-5.5'] } })
  markModelUnavailable('codex', 'gpt-5.6-sol', 1_000)
  assert.equal(agentModel('codex', 2_000), 'gpt-6-astra')
  assert.deepEqual(agentModelChain('codex', 2_000), ['gpt-6-astra', 'gpt-5.5', 'gpt-5.6-sol'], 'moved to the end, never dropped')
  assert.equal(agentModel('codex', 1_000 + MODEL_COOLDOWN_MS), 'gpt-5.6-sol')
})
