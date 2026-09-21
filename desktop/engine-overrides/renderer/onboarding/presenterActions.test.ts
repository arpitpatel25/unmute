import assert from 'node:assert/strict'
import test from 'node:test'

import { successButtonForAction } from './presenterActions'

test('passive lessons continue while orientation and sign-in keep their dedicated actions', () => {
  assert.deepEqual(successButtonForAction('welcome'), { label: 'Continue', type: 'continue' })
  assert.deepEqual(successButtonForAction('agent-notes'), { label: 'Continue', type: 'continue' })
  assert.deepEqual(successButtonForAction('product-orientation'), { label: 'Explore Unmute', type: 'complete-orientation' })
  assert.deepEqual(successButtonForAction('sign-in'), { label: 'Sign in', type: 'open-sign-in' })
})
