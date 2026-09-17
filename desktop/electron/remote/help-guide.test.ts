import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveHelpGuide, searchHelpGuide } from './help-guide.ts'

const modes = ['tap-toggle', 'push-to-talk', 'double-tap-push'] as const

test('resolves only the configured dictation key and the complementary session key', () => {
  for (const dictationKey of ['fn', 'right-option'] as const) {
    for (const activationMode of modes) {
      const guide = resolveHelpGuide({ dictationKey, activationMode })
      assert.equal(guide.settings.dictationKey, dictationKey === 'fn' ? 'Fn' : 'Right Option')
      assert.equal(guide.settings.sessionKey, dictationKey === 'fn' ? 'Right Option' : 'Fn')
      const dictation = guide.sections[0].entries.find((entry) => entry.id === 'dictation-talk')!
      assert.match(dictation.shortcut!, new RegExp(guide.settings.dictationKey))
      assert.doesNotMatch(dictation.shortcut!, /depending on settings/i)
      assert.doesNotMatch(dictation.shortcut!, new RegExp(dictationKey === 'fn' ? 'Right Option' : '\\bFn\\b'))
    }
  }
})

test('resolves the exact dictation activation gesture', () => {
  const expected = {
    'tap-toggle': 'Tap Fn to start. Tap it again to finish.',
    'push-to-talk': 'Hold Fn while you talk. Let go to finish.',
    'double-tap-push': 'Double-tap Fn for hands-free, or hold it while you talk.',
  }
  for (const activationMode of modes) {
    const guide = resolveHelpGuide({ dictationKey: 'fn', activationMode })
    assert.equal(guide.sections[0].entries.find((entry) => entry.id === 'dictation-talk')?.shortcut, expected[activationMode])
  }
})

test('contains the approved mental model and verified shortcuts without removed features', () => {
  const guide = resolveHelpGuide({ dictationKey: 'fn', activationMode: 'tap-toggle' })
  assert.deepEqual(guide.sections.map((section) => section.id), ['dictation', 'sessions', 'notetaker', 'notch'])
  const text = JSON.stringify(guide)
  for (const phrase of ['Scratchpad', 'copied text', 'screenshot', 'session manager', 'Right Command', 'Left Control', 'Left Command', 'Escape', 'Return']) {
    assert.match(text, new RegExp(phrase, 'i'))
  }
  assert.doesNotMatch(text, /\bInstruct\b/)
  assert.doesNotMatch(text, /\bTab\b|\b1[–-]9\b|\btoggle the fuller view\b/i)
})

test('search finds concise answers for common how-to questions', () => {
  const guide = resolveHelpGuide({ dictationKey: 'right-option', activationMode: 'push-to-talk' })
  assert.equal(searchHelpGuide(guide, 'resume a session')[0]?.id, 'agent-manager')
  assert.equal(searchHelpGuide(guide, 'screenshot while dictating')[0]?.id, 'dictation-context')
  assert.equal(searchHelpGuide(guide, 'scratchpad')[0]?.id, 'dictation-scratchpad')
  assert.equal(searchHelpGuide(guide, 'right command')[0]?.id, 'agent-manager')
})
