import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import HowToUseUnmute, { makeGuideViewModel, type GuideData } from './HowToUseUnmute.tsx'

Object.assign(globalThis, { React })

const guide: GuideData = {
  title: 'How to use Unmute',
  intro: 'Talk instead of type.',
  settings: { dictationKey: 'Fn', sessionKey: 'Right Option', activationMode: 'tap-toggle' },
  sections: [
    { id: 'dictation', title: 'Dictation', intro: 'Put words under your cursor.', entries: [{ id: 'dictation-talk', title: 'Talk', summary: 'Voice into text.', shortcut: 'Tap Fn to start. Tap it again to finish.', example: 'Say hello.', keywords: [], source: 'keyboard.ts' }] },
    { id: 'sessions', title: 'Sessions and the Unmute Agent', intro: 'A session works. The Agent manages.', entries: [{ id: 'session-direct', title: 'Start one', summary: 'Talk to a session.', shortcut: 'Tap Right Option to start. Tap it again to send.', keywords: [], source: 'keyboard.ts' }] },
    { id: 'notetaker', title: 'Notetaker', intro: 'Meeting notes.', entries: [{ id: 'notetaker-record', title: 'Start meeting notes', summary: 'Keep a transcript.', shortcut: 'Double-tap Left Control to start. Double-tap it again to stop.', keywords: [], source: 'keyboard.ts' }] },
    { id: 'notch', title: 'Inside the notch', intro: 'Keep sessions close.', entries: [{ id: 'notch-navigation', title: 'Move around', summary: 'Use the keyboard.', shortcut: 'Escape closes the nearest open layer first, then shrinks the surface.', keywords: [], source: 'AppController.swift' }] },
  ],
}

test('keeps the guide glanceable and in the approved order', () => {
  const view = makeGuideViewModel(guide)
  assert.deepEqual(view.map((section) => section.id), ['dictation', 'sessions', 'notetaker', 'notch'])
  assert.equal(view[0].entries[0].shortcut, 'Tap Fn to start. Tap it again to finish.')
  assert.doesNotMatch(JSON.stringify(view), /depending on Settings|Instruct/)
})

test('renders one linear reference instead of a grid of independent cards', () => {
  const html = renderToStaticMarkup(React.createElement(HowToUseUnmute, { guide }))

  assert.equal((html.match(/<section/g) ?? []).length, 4)
  assert.equal((html.match(/<article/g) ?? []).length, 0)
  assert.match(html, /href="#dictation"/)
  assert.match(html, /href="#sessions"/)
  assert.match(html, /Dictation writes where your cursor is/)
  assert.match(html, /Tap Fn to start\. Tap it again to finish\./)
  assert.match(html, /<kbd[^>]*>Fn<\/kbd>/)
  assert.match(html, /Double-tap Left Control to start\. Double-tap it again to stop\./)
  assert.match(html, /<kbd[^>]*>Left Control<\/kbd>/)
  assert.match(html, /Escape closes the nearest open layer first/)
  assert.match(html, /<kbd[^>]*>Esc<\/kbd>/)
  assert.ok(html.indexOf('id="dictation"') < html.indexOf('id="sessions"'))
  assert.ok(html.indexOf('id="sessions"') < html.indexOf('id="notetaker"'))
  assert.ok(html.indexOf('id="notetaker"') < html.indexOf('id="notch"'))
})
