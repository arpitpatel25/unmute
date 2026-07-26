import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// The parsing rules for Codex's reasoning control, pinned against what its menu
// actually contains. Values were read live on 2026-07-25:
//
//   label   "5.6 Terra High"
//   Model   5.6 Sol · 5.6 Terra · 5.6 Luna · 5.5 · 5.4 · 5.4 Mini
//   Effort  Light · Medium · High · Extra High · Ultra
//   Speed   Standard · Fast
//
// None of these names is hardcoded anywhere in the product — they are read from
// the running app, because "5.6 Terra" will not exist in two releases and a
// managed plan may not offer every tier.

const AXIS_ROWS = new Set(['', 'Reset to default', 'Model', 'Effort', 'Speed'])

/** The filter used to separate submenu entries from the parent rows. */
const submenuItems = (all: string[]) =>
  all.map((t) => t.trim().split('\n')[0].trim()).filter((t) => !AXIS_ROWS.has(t))

/** The regex used to read the current value off each parent row. */
const currentOf = (rows: string[]) => {
  const out: Record<string, string> = {}
  for (const line of rows) {
    const m = /^(Model|Effort|Speed)\n?\s*(.*)$/.exec(line)
    if (m && m[2]) out[m[1]] = m[2].trim()
  }
  return out
}

describe('reading the reasoning control', () => {
  it('reads the current value off each parent row', () => {
    assert.deepEqual(
      currentOf(['Model\n5.6 Terra', 'Effort\nHigh', 'Speed\nStandard', 'Reset to default']),
      { Model: '5.6 Terra', Effort: 'High', Speed: 'Standard' },
    )
  })

  it('separates submenu entries from the parent rows', () => {
    // Verbatim from the live DOM with the Effort submenu open.
    const dom = ['', 'Reset to default', 'Model', 'Effort', 'Speed',
                 'Light', 'Medium', 'High', 'Extra High', 'Ultra']
    assert.deepEqual(submenuItems(dom), ['Light', 'Medium', 'High', 'Extra High', 'Ultra'])
  })

  it('keeps a model name that happens to look like a parent row would not', () => {
    const dom = ['', 'Reset to default', 'Model', 'Effort', 'Speed',
                 '5.6 Sol', '5.6 Terra', '5.6 Luna', '5.5', '5.4', '5.4 Mini']
    assert.deepEqual(submenuItems(dom).length, 6)
  })

  it('takes only the first line of a two-line entry', () => {
    // "Ultra\nConsumes usage limits faster" — the caption is not the value.
    assert.deepEqual(submenuItems(['Ultra\nConsumes usage limits faster']), ['Ultra'])
    assert.deepEqual(submenuItems(['Fast\n1.5x speed, more usage']), ['Fast'])
  })

  it('returns nothing rather than guessing when the menu did not open', () => {
    assert.deepEqual(submenuItems([]), [])
    assert.deepEqual(submenuItems(['', 'Reset to default', 'Model', 'Effort', 'Speed']), [])
  })
})
