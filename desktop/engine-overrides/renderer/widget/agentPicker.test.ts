import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldShowAgentPicker,
  offeredAgents,
  currentAgentLabel,
  currentAgentConnected,
  nextAgentId,
  type AgentPickerState,
} from './agentPicker'

// The values below are the REAL ones observed on a live machine, not invented:
//   * a Remote capture starts as startSession('dictation', 'remote') —
//     sessionManager.ts:887 — so mode says "dictation" while kind says "remote";
//   * the main process logged
//     agent-options {"current":"claude","installed":true,"codexAvailable":true,"offered":2}
//     on every Remote capture while the chip was still invisible.
// Together those are the bug this file exists to prevent.

const BOTH: AgentPickerState = {
  current: 'claude',
  options: [
    { id: 'claude', label: 'Claude Code', available: true },
    { id: 'codex-desktop', label: 'Codex', available: true, installed: true },
  ],
}
const CODEX_UNARMED: AgentPickerState = {
  current: 'claude',
  options: [
    { id: 'claude', label: 'Claude Code', available: true },
    { id: 'codex-desktop', label: 'Codex', available: false, installed: true },
  ],
}
const CLAUDE_ONLY: AgentPickerState = {
  current: 'claude',
  options: [
    { id: 'claude', label: 'Claude Code', available: true },
    { id: 'codex-desktop', label: 'Codex', available: false, installed: false },
  ],
}

describe('backend picker visibility', () => {
  it('SHOWS on a Remote capture — the case that was broken for four builds', () => {
    // THE REGRESSION TEST. The widget's state during a Remote capture is
    // 'dictation-active' (mode axis), so any guard written against
    // state === 'instruction-active' is false here and the chip never renders.
    // Visibility must depend on the KIND axis only.
    assert.equal(shouldShowAgentPicker({ isRemote: true, picker: BOTH }), true)
  })

  it('HIDES during dictation — typing text creates no task to route', () => {
    assert.equal(shouldShowAgentPicker({ isRemote: false, picker: BOTH }), false)
  })

  it('shows an installed-but-unconnected Codex, so it can be connected', () => {
    // Hiding it is what left the user with no way to arm Codex and no hint the
    // feature existed.
    assert.equal(shouldShowAgentPicker({ isRemote: true, picker: CODEX_UNARMED }), true)
    assert.equal(currentAgentConnected({ ...CODEX_UNARMED, current: 'codex-desktop' }), false)
  })

  it('hides when Codex is not installed — one backend is not a choice', () => {
    assert.equal(shouldShowAgentPicker({ isRemote: true, picker: CLAUDE_ONLY }), false)
  })

  it('hides before options have loaded, rather than rendering an empty chip', () => {
    assert.equal(shouldShowAgentPicker({ isRemote: true, picker: null }), false)
    assert.equal(shouldShowAgentPicker({ isRemote: true, picker: undefined }), false)
  })
})

describe('backend picker labels + cycling', () => {
  it('labels the current backend', () => {
    assert.equal(currentAgentLabel(BOTH), 'Claude Code')
    assert.equal(currentAgentLabel({ ...BOTH, current: 'codex-desktop' }), 'Codex')
  })

  it('falls back to the first offered backend when current is unknown', () => {
    assert.equal(currentAgentLabel({ ...BOTH, current: 'nonsense' }), 'Claude Code')
  })

  it('cycles claude -> codex -> claude', () => {
    assert.equal(nextAgentId(BOTH), 'codex-desktop')
    assert.equal(nextAgentId({ ...BOTH, current: 'codex-desktop' }), 'claude')
  })

  it('never cycles when there is only one real choice', () => {
    assert.equal(nextAgentId(CLAUDE_ONLY), null)
  })

  it('offers exactly the backends the host reported usable or installed', () => {
    assert.deepEqual(offeredAgents(BOTH).map((o) => o.id), ['claude', 'codex-desktop'])
    assert.deepEqual(offeredAgents(CLAUDE_ONLY).map((o) => o.id), ['claude'])
  })
})
