import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_PRINCIPLES, agentConstitution } from './constitution'

/**
 * `a64ab19` replaced the paragraph telling the Agent to Glob and Grep the disk
 * with one describing the index — and left both tools in the allowlist. It kept
 * the capability and lost the instruction to use it, which is an Agent that
 * behaves LESS capable than a bare Claude Code session while holding the exact
 * tools that would answer. This is the test that keeps the fallback nameable.
 */
test('the raw-search fallback is named, not merely permitted', () => {
  assert.match(AGENT_PRINCIPLES, /Glob, Grep and Read/)
  assert.match(AGENT_PRINCIPLES, /~\/\.claude\/projects/)
  assert.match(AGENT_PRINCIPLES, /~\/\.codex\/sessions/)
})

test('the ladder runs record, then older summaries, then the disk', () => {
  const record = AGENT_PRINCIPLES.indexOf('READ THAT FILE FIRST')
  const fallback = AGENT_PRINCIPLES.indexOf('WHEN THE RECORD DOES NOT HAVE IT')
  assert.ok(record > 0 && fallback > record, 'the fallback follows the record')
  assert.match(AGENT_PRINCIPLES, /shortcut, never the edge of what you can see/)
  assert.match(AGENT_PRINCIPLES, /only true once you have actually looked/)
})

/**
 * The ladder and the retrieval rule point opposite ways. Without an explicit
 * seam, "fall back to searching the disk" contradicts "do not go looking", and
 * the Agent crawls the filesystem every time it is asked where something was
 * saved.
 */
test('the ladder is sealed off from the memory-retrieval rule', () => {
  assert.match(AGENT_PRINCIPLES, /NONE OF THIS APPLIES TO YOUR OWN MEMORY/)
  assert.match(AGENT_PRINCIPLES, /empty memory is still an honest answer/)
  // The rule it must not contradict is still present and unweakened.
  assert.match(AGENT_PRINCIPLES, /RETRIEVAL MEANS YOUR MEMORY/)
  assert.match(AGENT_PRINCIPLES, /Do not go looking/)
})

test('the record is named by path, so there is one place to look', () => {
  assert.match(AGENT_PRINCIPLES, /sessions\/recent-sessions\.md/)
})

/**
 * Cross-harness continuation is composed by the Agent, not by a template in
 * TypeScript, and it must never be described as moving a thread.
 */
test('carrying work across harnesses is composed, and described honestly', () => {
  assert.match(AGENT_PRINCIPLES, /read what you need, write the account yourself/)
  assert.match(AGENT_PRINCIPLES, /Never paste session identifiers into a task/)
  assert.match(AGENT_PRINCIPLES, /never "moved them to Codex"/)
})

test('resuming needs no name for the session', () => {
  assert.match(AGENT_PRINCIPLES, /session_resume/)
  assert.match(AGENT_PRINCIPLES, /never answer a question about their own past with a question/)
})

/** Deleted tools must not still be advertised as available. */
test('no removed tool is still named as if it existed', () => {
  for (const gone of ['sessions_list', 'sessions_search', 'session_read', 'session_continue_in']) {
    assert.doesNotMatch(AGENT_PRINCIPLES, new RegExp(gone), `${gone} is gone but still named`)
  }
})

test('the session preamble is composed in, not replaced', () => {
  const composed = agentConstitution('SESSION PREAMBLE HERE')
  assert.match(composed, /^SESSION PREAMBLE HERE/)
  assert.ok(composed.includes(AGENT_PRINCIPLES))
})
