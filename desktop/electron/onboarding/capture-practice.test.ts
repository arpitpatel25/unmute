import assert from 'node:assert/strict'
import test from 'node:test'
import { captureEvents } from './capture-practice'
import { initialProgress, reduceOnboarding } from './machine'

test('a screenshot observed but omitted from delivery does not advance', () => {
  let progress = initialProgress({ action: 'screenshot-capture' })
  for (const event of captureEvents({ captureId: 'c2', observed: [{ id: 's1', kind: 'screenshot' }], deliveredItemIds: [], targetBundleId: 'com.apple.Notes' })) progress = reduceOnboarding(progress, event)
  assert.equal(progress.action, 'screenshot-capture')
})

test('the matching captured item delivered advances', () => {
  let progress = initialProgress({ action: 'clipboard-capture' })
  for (const event of captureEvents({ captureId: 'c2', observed: [{ id: 'p1', kind: 'clipboard-text' }], deliveredItemIds: ['p1'], targetBundleId: 'com.apple.Notes' })) progress = reduceOnboarding(progress, event)
  assert.equal(progress.action, 'screenshot-capture')
})
