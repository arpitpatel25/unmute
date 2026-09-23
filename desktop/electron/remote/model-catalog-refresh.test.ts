import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldRefreshModelCatalog } from './model-catalog-refresh'

test('a populated model catalog refreshes after its live-data TTL', () => {
  assert.equal(shouldRefreshModelCatalog({ count: 5, loading: false, attemptedAt: 1_000, now: 600_999 }), false)
  assert.equal(shouldRefreshModelCatalog({ count: 5, loading: false, attemptedAt: 1_000, now: 601_000 }), true)
})

test('an empty model catalog retries quickly without overlapping a live read', () => {
  assert.equal(shouldRefreshModelCatalog({ count: 0, loading: false, attemptedAt: 1_000, now: 30_999 }), false)
  assert.equal(shouldRefreshModelCatalog({ count: 0, loading: false, attemptedAt: 1_000, now: 31_000 }), true)
  assert.equal(shouldRefreshModelCatalog({ count: 0, loading: true, attemptedAt: 1_000, now: 100_000 }), false)
})
