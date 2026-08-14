// desktop/electron/remote/capture/clipboardLedger.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert'
import {
  createLedger, noteOwnWrite, shouldObserve, claimContent, resetLedger, DEDUP_WINDOW_MS, createClaims,
} from './clipboardLedger'

describe('our own writes are unobservable BY CONSTRUCTION', () => {
  test('a changeCount we caused is never observed', () => {
    const l = createLedger()
    noteOwnWrite(l, 42)
    assert.equal(shouldObserve(l, 42), false)
  })

  test('captureSelection then injectOutput — both of ours, neither observed', () => {
    const l = createLedger()
    noteOwnWrite(l, 10)  // synthetic Cmd+C at capture start
    noteOwnWrite(l, 11)  // transcript written for pasting
    assert.equal(shouldObserve(l, 10), false)
    assert.equal(shouldObserve(l, 11), false)
  })

  test('a user copy BETWEEN two of our writes is still observed', () => {
    const l = createLedger()
    noteOwnWrite(l, 10)
    assert.equal(shouldObserve(l, 11), true)  // the user
    noteOwnWrite(l, 12)
    assert.equal(shouldObserve(l, 12), false)
  })

  test('an unrecorded changeCount is observed — the default is to capture', () => {
    assert.equal(shouldObserve(createLedger(), 7), true)
  })

  test('the same changeCount asked twice answers the same both times', () => {
    const l = createLedger()
    noteOwnWrite(l, 5)
    assert.equal(shouldObserve(l, 5), false)
    assert.equal(shouldObserve(l, 5), false)
  })
})

describe('one user action yields one insert', () => {
  test('a tool that writes a file AND copies fires both detectors, inserts once', () => {
    const l = createLedger()
    assert.equal(claimContent(l, 'hash-abc', 1000), true)   // clipboard detector
    assert.equal(claimContent(l, 'hash-abc', 1150), false)  // file detector, same shot
  })

  test('different content within the window both land', () => {
    const l = createLedger()
    assert.equal(claimContent(l, 'hash-a', 1000), true)
    assert.equal(claimContent(l, 'hash-b', 1100), true)
  })

  test('the same content copied again AFTER the window is a real second insert', () => {
    const l = createLedger()
    assert.equal(claimContent(l, 'hash-a', 1000), true)
    assert.equal(claimContent(l, 'hash-a', 1000 + DEDUP_WINDOW_MS + 1), true)
  })

  test('exactly at the window boundary is still a duplicate', () => {
    const l = createLedger()
    assert.equal(claimContent(l, 'hash-a', 1000), true)
    assert.equal(claimContent(l, 'hash-a', 1000 + DEDUP_WINDOW_MS), false)
  })
})

describe('resetLedger', () => {
  test('a new capture window starts clean', () => {
    const l = createLedger()
    noteOwnWrite(l, 1)
    claimContent(l, 'h', 100)
    resetLedger(l)
    assert.equal(shouldObserve(l, 1), true)
    assert.equal(claimContent(l, 'h', 100), true)
  })
})

// DEDUP EXISTS FOR ONE ACTION SEEN TWICE, NOT FOR TWO DELIBERATE ACTIONS.
//
// The window collapses identical content so a screenshot tool that writes a
// file AND copies to the pasteboard yields one insert. But keyed on content
// alone it cannot tell that apart from the user capturing the same thing
// twice: screenshot an unchanged region twice and the PNG bytes are identical,
// so the second capture vanished silently. Field report: "I tried attaching
// multiple images but it did not do that", with one image in the buffer.
//
// The distinguishing signal is WHICH detector saw it. Two detectors on one
// action is a duplicate; one detector twice is two actions, and every capture
// the user made must arrive.
describe('claims distinguish one action from two', () => {
  test('the same content from a DIFFERENT detector is one action, claimed once', () => {
    const claims = createClaims(2000)
    assert.equal(claimContent(claims, 'img-sig', 1000, undefined, 'clipboard'), true)
    assert.equal(
      claimContent(claims, 'img-sig', 1200, undefined, 'screenshot'), false,
      'a file write and its pasteboard copy are one screenshot',
    )
  })

  test('the same content from the SAME detector twice is two captures, both kept', () => {
    const claims = createClaims(2000)
    assert.equal(claimContent(claims, 'img-sig', 1000, undefined, 'clipboard'), true)
    assert.equal(
      claimContent(claims, 'img-sig', 1200, undefined, 'clipboard'), true,
      'capturing the same region twice is two deliberate captures',
    )
  })

  test('an unlabelled claim keeps the old content-only behaviour', () => {
    const claims = createClaims(2000)
    assert.equal(claimContent(claims, 'text:hello', 1000), true)
    assert.equal(claimContent(claims, 'text:hello', 1100), false)
  })
})
