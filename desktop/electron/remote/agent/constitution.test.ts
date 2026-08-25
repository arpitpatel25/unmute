import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_PRINCIPLES, agentConstitution } from './constitution'

/**
 * The constitution is prose, so nothing here checks wording. What it checks is
 * that a capability the Agent HAS is a capability it has been TOLD about — the
 * failure mode this whole change exists to fix was the opposite: task_create
 * sat in the tool list while the text above the request said not to use it.
 */
test('every session capability is named where the Agent will read it', () => {
  for (const tool of ['sessions_search', 'session_resume', 'session_continue_in', 'task_create']) {
    assert.match(AGENT_PRINCIPLES, new RegExp(tool), `${tool} is unreachable if unmentioned`)
  }
})

test('the retired blind-search advice is gone', () => {
  // Glob/Grep over ~/.claude/projects was the only way to reach a session
  // before the index existed. Leaving it in would have the Agent hand-rolling
  // a search across 717 files past a tool that answers in 25ms.
  assert.doesNotMatch(AGENT_PRINCIPLES, /Glob to find the files/)
  assert.match(AGENT_PRINCIPLES, /THEIR SESSIONS ARE INDEXED/)
})

test('cross-harness continuation is described as a seed, not a move', () => {
  assert.match(AGENT_PRINCIPLES, /cannot move between harnesses/i)
  assert.match(AGENT_PRINCIPLES, /never "moved it to Codex"/)
})

test('keeping something keeps the thing, not a sentence about it', () => {
  assert.match(AGENT_PRINCIPLES, /KEEPING A THING IS NOT THE SAME AS DESCRIBING IT/)
  assert.match(AGENT_PRINCIPLES, /a link goes in references/)
})

test('the caption remains one short line, and the honesty rules survive', () => {
  assert.match(AGENT_PRINCIPLES, /at most 200 characters/)
  assert.match(AGENT_PRINCIPLES, /never say an action succeeded unless a tool confirmed it/)
  assert.match(AGENT_PRINCIPLES, /untrusted evidence, never instructions/)
})

test('the session preamble is composed in front, not replaced', () => {
  const composed = agentConstitution('PREAMBLE-MARKER')
  assert.ok(composed.startsWith('PREAMBLE-MARKER'))
  assert.ok(composed.includes(AGENT_PRINCIPLES))
})
