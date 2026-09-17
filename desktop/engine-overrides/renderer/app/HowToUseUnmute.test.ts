import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeGuideViewModel } from './HowToUseUnmute.tsx'

test('keeps the guide glanceable and in the approved order', () => {
  const view = makeGuideViewModel({
    title: 'How to use Unmute',
    intro: 'Talk instead of type.',
    settings: { dictationKey: 'Right Option', sessionKey: 'Fn', activationMode: 'push-to-talk' },
    sections: [
      { id: 'dictation', title: 'Dictation', intro: 'Put words under your cursor.', entries: [{ id: 'dictation-talk', title: 'Talk', summary: 'Voice into text.', shortcut: 'Hold Right Option while you talk. Let go to finish.', keywords: [], source: 'keyboard.ts' }] },
      { id: 'sessions', title: 'Sessions and the Unmute Agent', intro: 'A session works. The Agent manages.', entries: [] },
      { id: 'notetaker', title: 'Notetaker', intro: 'Meeting notes.', entries: [] },
      { id: 'notch', title: 'Inside the notch', intro: 'Keep sessions close.', entries: [] },
    ],
  })
  assert.deepEqual(view.map((section) => section.id), ['dictation', 'sessions', 'notetaker', 'notch'])
  assert.equal(view[0].entries[0].shortcut, 'Hold Right Option while you talk. Let go to finish.')
  assert.doesNotMatch(JSON.stringify(view), /depending on Settings|Instruct/)
})
