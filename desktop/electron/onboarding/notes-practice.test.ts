import assert from 'node:assert/strict'
import test from 'node:test'
import { notesEventFromReceipt, openNotesPractice } from './notes-practice'

test('Notes is armed only after it becomes frontmost', async () => {
  const seen = ['com.apple.finder', 'com.apple.Notes']
  const ok = await openNotesPractice({ launch: async () => {}, frontmostBundleId: async () => seen.shift() ?? null, sleep: async () => {} })
  assert.equal(ok, true)
})

test('wrong-app and transcription-only state cannot produce a delivery event', () => {
  assert.equal(notesEventFromReceipt({ captureId: 'c1', mode: 'dictation', targetBundleId: 'com.apple.TextEdit', delivered: true }), null)
  assert.equal(notesEventFromReceipt({ captureId: 'c1', mode: 'dictation', targetBundleId: 'com.apple.Notes', delivered: false }), null)
})

test('instruction delivery is not part of onboarding', () => {
  const event = notesEventFromReceipt({ captureId: 'c1', mode: 'instruction', targetBundleId: 'com.apple.Notes', delivered: true, changedSelection: false })
  assert.equal(event, null)
})
