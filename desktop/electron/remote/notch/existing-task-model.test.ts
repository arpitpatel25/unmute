import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyExistingTaskModelPick, existingTaskModelLabel, resolveExistingTaskModelChange } from './existing-task-model'

const config = {
  mutable: true,
  busy: false,
  models: [
    { id: 'gpt-5.6-terra', label: '5.6 Terra' },
    { id: 'gpt-5.6-sol', label: '5.6 Sol' },
  ],
  efforts: [
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
  ],
}

test('an addressed pill model label resolves to the conversation model id', () => {
  assert.deepEqual(
    resolveExistingTaskModelChange(config, { axis: 'Model', value: '5.6 Sol' }),
    { change: { model: 'gpt-5.6-sol' } },
  )
})

test('an addressed pill effort label resolves to the conversation effort id', () => {
  assert.deepEqual(
    resolveExistingTaskModelChange(config, { axis: 'Effort', value: 'High' }),
    { change: { effort: 'high' } },
  )
})

test('an addressed pill refuses model changes while the conversation is busy or externally managed', () => {
  assert.match(resolveExistingTaskModelChange({ ...config, busy: true }, { axis: 'Model', value: '5.6 Sol' }).error ?? '', /turn finishes/i)
  assert.match(resolveExistingTaskModelChange({ ...config, mutable: false }, { axis: 'Model', value: '5.6 Sol' }).error ?? '', /original application/i)
})

test('an addressed conversation never accepts an unrelated global model value', () => {
  assert.match(resolveExistingTaskModelChange(config, { axis: 'Model', value: 'Opus' }).error ?? '', /not offered/i)
  assert.match(resolveExistingTaskModelChange(config, { axis: 'Speed', value: 'Fast' }).error ?? '', /not configurable/i)
})

test('the accepted model id is presented with its provider label immediately', () => {
  assert.equal(existingTaskModelLabel(config.models, 'gpt-5.6-sol', 'gpt-5.6-sol'), '5.6 Sol')
  assert.equal(existingTaskModelLabel([], 'custom-model', 'Custom model'), 'Custom model')
})

test('an addressed pill applies its selection through conversation configuration', async () => {
  const applied: unknown[] = []
  const result = await applyExistingTaskModelPick(config, { axis: 'Model', value: '5.6 Sol' }, async change => {
    applied.push(change)
  })
  assert.deepEqual(result, { change: { model: 'gpt-5.6-sol' } })
  assert.deepEqual(applied, [{ model: 'gpt-5.6-sol' }])
})

test('a rejected addressed selection never reaches conversation configuration', async () => {
  let applied = false
  const result = await applyExistingTaskModelPick(config, { axis: 'Speed', value: 'Fast' }, async () => { applied = true })
  assert.match(result.error ?? '', /not configurable/i)
  assert.equal(applied, false)
})
