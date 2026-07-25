import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDecision, type AgentAvailability } from '../router'

// The router is an LM. These tests pin the TRUST BOUNDARY: whatever it emits,
// a task must never be promised to a backend the host cannot reach — the user
// would be told their work started somewhere it never did.

const BOTH: AgentAvailability = {
  agents: ['claude', 'codex-desktop'],
  preferred: 'claude',
  codexProjects: ['unmute', 'calorify'],
}
const CLAUDE_ONLY: AgentAvailability = { agents: ['claude'], preferred: 'claude' }

const decide = (obj: Record<string, unknown>, avail?: AgentAvailability) =>
  parseDecision(JSON.stringify({ action: 'new', intent: 'do it', ...obj }), 'do it', [], [], [], [], [], [], avail)

test('an available backend the user named is honoured', () => {
  const d = decide({ agent: 'codex-desktop' }, BOTH)
  assert.equal(d.action, 'new')
  assert.equal(d.agent, 'codex-desktop')
})

test('an UNAVAILABLE backend is dropped — host falls back to its default', () => {
  // Codex not installed/armed: the option was never offered, so naming it must
  // not strand the task in an app that cannot take it.
  const d = decide({ agent: 'codex-desktop' }, CLAUDE_ONLY)
  assert.equal(d.agent, undefined)
})

test('a hallucinated backend is dropped', () => {
  const d = decide({ agent: 'gemini-cli' }, BOTH)
  assert.equal(d.agent, undefined)
})

test('no availability supplied ⇒ no agent is ever set', () => {
  // Belt and braces: a caller that forgets to pass availability gets the old
  // behaviour (host default), never a surprise backend.
  const d = decide({ agent: 'codex-desktop' })
  assert.equal(d.agent, undefined)
})

test('a known Codex project is kept', () => {
  const d = decide({ agent: 'codex-desktop', codexProject: 'unmute' }, BOTH)
  assert.equal(d.codexProject, 'unmute')
})

test('an unknown Codex project is dropped, the backend survives', () => {
  // Better to create the task at the top level than in a project that does not
  // exist — dropping the project must not drop the task.
  const d = decide({ agent: 'codex-desktop', codexProject: 'not-a-real-project' }, BOTH)
  assert.equal(d.agent, 'codex-desktop')
  assert.equal(d.codexProject, undefined)
})

test('codexProject without the Codex backend is meaningless and dropped', () => {
  const d = decide({ agent: 'claude', codexProject: 'unmute' }, BOTH)
  assert.equal(d.agent, 'claude')
  assert.equal(d.codexProject, undefined)
})

test('omitting agent leaves it undefined so the host applies the picker default', () => {
  const d = decide({}, BOTH)
  assert.equal(d.agent, undefined)
})
