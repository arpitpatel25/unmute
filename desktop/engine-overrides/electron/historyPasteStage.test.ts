import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { HistoryPasteStage } from './historyPasteStage'

describe('HistoryPasteStage', () => {
  test('hands a staged composition to exactly the next unchanged paste', () => {
    const stage = new HistoryPasteStage()
    stage.set({ text: 'words', images: ['/one.png', '/two.png'] }, { changeCount: 42, text: 'words' })

    assert.deepEqual(stage.take({ changeCount: 42, text: 'words' }), {
      text: 'words',
      images: ['/one.png', '/two.png'],
    })
    assert.equal(stage.take({ changeCount: 42, text: 'words' }), null)
  })

  test('an intervening clipboard write cancels the staged images', () => {
    const stage = new HistoryPasteStage()
    stage.set({ text: 'same words', images: ['/old.png'] }, { changeCount: 7, text: 'same words' })

    // The clipboard can contain identical text after a second copy. Its native
    // change counter is what prevents stale history images joining that paste.
    assert.equal(stage.take({ changeCount: 8, text: 'same words' }), null)
  })

  test('falls back to matching text when a native change counter is unavailable', () => {
    const stage = new HistoryPasteStage()
    stage.set({ text: 'history', images: ['/shot.png'] }, { changeCount: null, text: 'history' })

    assert.equal(stage.take({ changeCount: null, text: 'something else' }), null)

    stage.set({ text: 'history', images: ['/shot.png'] }, { changeCount: null, text: 'history' })
    assert.deepEqual(stage.take({ changeCount: null, text: 'history' }), {
      text: 'history', images: ['/shot.png'],
    })
  })

  test('staging a newer history item replaces the older one', () => {
    const stage = new HistoryPasteStage()
    stage.set({ text: 'old', images: ['/old.png'] }, { changeCount: 1, text: 'old' })
    stage.set({ text: 'new', images: ['/new.png'] }, { changeCount: 2, text: 'new' })

    assert.deepEqual(stage.take({ changeCount: 2, text: 'new' }), {
      text: 'new', images: ['/new.png'],
    })
  })
})
