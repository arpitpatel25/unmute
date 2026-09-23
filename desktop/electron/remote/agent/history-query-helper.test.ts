import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planHistoryTerms } from './history-query-helper'

test('history query helper tries lightweight models without using the Agent model', async () => {
  const models: string[] = []
  const terms = await planHistoryTerms('Find the older laptop discussion', 'codex',
    ['gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-terra'],
    async (_request, _provider, model) => {
      models.push(model)
      if (models.length === 1) throw new Error('unavailable')
      return '{"terms":["Vinyas laptop","company policy"]}'
    })
  assert.deepEqual(models, ['gpt-6-luna', 'gpt-5.6-terra'])
  assert.deepEqual(terms, ['Vinyas laptop', 'company policy'])
})

test('history query helper skips an unavailable light model instead of using Opus', async () => {
  let called = false
  const terms = await planHistoryTerms('Find the old session', 'codex', ['gpt-6-astra'], async () => { called = true; return '' })
  assert.deepEqual(terms, [])
  assert.equal(called, false)
})
