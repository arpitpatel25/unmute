import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeModelChoices } from './model-choices'
import type { ClaudeTaskModel } from './task-session'

const model = (id: string, label = id): ClaudeTaskModel => ({ id, label, efforts: [] })

test('Claude menus show recommended live choices without duplicate aliases or old versions', () => {
  const live = ['default', 'opus[1m]', 'claude-fable-5-1[1m]', 'sonnet', 'haiku', 'opus', 'claude-opus-4-8', 'claude-sonnet-5'].map(id => model(id))
  assert.deepEqual(claudeModelChoices(live).map(choice => choice.id), live.slice(0, 5).map(choice => choice.id))
  assert.deepEqual(claudeModelChoices(live, 'claude-opus-4-8').map(choice => choice.id), [...live.slice(0, 5).map(choice => choice.id), 'claude-opus-4-8'])
})

test('Claude menus keep new aliases and use an available Opus when 1M is absent', () => {
  const live = ['default', 'opus', 'sonnet', 'haiku', 'nova'].map(id => model(id))
  assert.deepEqual(claudeModelChoices(live).map(choice => choice.id), live.map(choice => choice.id))
})
