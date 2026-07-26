import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { panelRows, hudHeight, contentOffset, HUD_BASE } from './hudSizing'

// The real axes, as read from a live Codex on 2026-07-26.
const CODEX_AXES = [
  { values: ['5.6 Sol', '5.6 Terra', '5.6 Luna', '5.5', '5.4', '5.4 Mini'] },  // 6
  { values: ['Light', 'Medium', 'High', 'Extra High', 'Ultra'] },              // 5
  { values: ['Standard', 'Fast'] },                                            // 2
]

describe('how tall the panel actually is', () => {
  it('measures the TALLEST COLUMN, not the sum of every axis', () => {
    // Summing gives 13 and asked for a 440px window around a ~230px panel —
    // that was the empty gap above the list.
    assert.equal(panelRows(true, CODEX_AXES, 0), 6 + 0.8)
  })

  it('Codex is SHORTER than a Claude list, which is what the eye sees', () => {
    // The old maths made the window GROW while the panel visibly shrank.
    const codex = hudHeight(true, panelRows(true, CODEX_AXES, 0))
    const claude = hudHeight(true, panelRows(false, [], 8))
    assert.ok(codex < claude, `codex ${codex} should be under claude ${claude}`)
  })

  it('never asks for a taller window than the screen can give', () => {
    const huge = Array.from({ length: 40 }, (_, i) => `m${i}`)
    assert.equal(hudHeight(true, panelRows(true, [{ values: huge }], 0)), 440)
  })

  it('is the base height when closed, whatever the list holds', () => {
    assert.equal(hudHeight(false, panelRows(true, CODEX_AXES, 0)), HUD_BASE)
  })

  it('asks for nothing extra when Codex has not answered yet', () => {
    // Mid-switch the axes are briefly empty; that must not compute a negative
    // or a NaN row count and drive the window somewhere absurd.
    assert.equal(panelRows(true, [], 0), 0)
    assert.equal(hudHeight(true, 0), HUD_BASE + 4)
  })
})

describe('keeping the pill still while the window grows', () => {
  it('offsets by exactly the growth, divided by the pill scale', () => {
    // The window grows upward, so content must come down by the same amount;
    // padding inside a 0.75-scaled element scales with it.
    assert.equal(contentOffset(HUD_BASE), 0)
    assert.equal(contentOffset(HUD_BASE + 75), 100)
  })

  it('is zero at rest, so the resting position is untouched', () => {
    assert.equal(contentOffset(hudHeight(false, 99)), 0)
  })
})
