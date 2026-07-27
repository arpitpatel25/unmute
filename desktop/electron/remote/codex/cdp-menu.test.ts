import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pickMenuItem, type MenuItem } from './cdp'

const row = (text: string, y: number): MenuItem => ({ text, x: 100, y })

/** Codex's real model submenu: names alone, and names with a subtitle. */
const PLAIN: MenuItem[] = [row('5.4 Mini', 10), row('5.4', 20), row('5.6 Sol', 30)]
const SUBTITLED: MenuItem[] = [
  row('5.6 Sol\nLatest frontier agentic coding model.', 10),
  row('5.6 Luna\nFaster.', 20),
]

describe('pickMenuItem', () => {
  test('EXACT BEFORE PREFIX — "5.4" must not select "5.4 Mini"', () => {
    // Mini is listed FIRST, so a bare startsWith would have claimed it.
    assert.equal(pickMenuItem(PLAIN, '5.4')!.y, 20)
  })

  test('the mini is still reachable by its own name', () => {
    assert.equal(pickMenuItem(PLAIN, '5.4 Mini')!.y, 10)
  })

  test('matches the first line when the row carries a description', () => {
    assert.equal(pickMenuItem(SUBTITLED, '5.6 Sol')!.y, 10)
  })

  test('case and stray whitespace do not matter', () => {
    assert.equal(pickMenuItem(PLAIN, '  5.6 SOL ')!.y, 30)
  })

  test('a value the menu does not offer returns null, never a near miss', () => {
    assert.equal(pickMenuItem(PLAIN, 'GPT-5.6-Sol'), null)   // the old bug, now visible
    assert.equal(pickMenuItem(PLAIN, ''), null)
    assert.equal(pickMenuItem([], '5.4'), null)
  })
})
