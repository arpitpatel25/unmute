import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentConstitution } from './constitution.ts'
import { MemoryCapability } from './capabilities/memory.ts'
import { HistoryCapability } from './capabilities/history.ts'
import { SessionsCapability } from './capabilities/sessions.ts'
import { HandoffCapability } from './capabilities/handoff.ts'
import { NotetakerCapability } from './capabilities/notetaker.ts'
import { DeliveryCapability } from './capabilities/delivery.ts'

/**
 * A CAPABILITY THE PROSE NEVER NAMES IS A DEAD ROUTE.
 *
 * Measured over 11 days of real use: 228 tool calls, and eight tools never
 * invoked once. The pattern behind it is that the model picks what to do from
 * the constitution and only then reaches for a tool, so a tool that exists
 * solely in the schema block competes from the weakest position in the prompt.
 * Shipping a capability nobody can reach is worse than not shipping it: it
 * costs prompt budget on every turn and reads, from the outside, as the Agent
 * being unable to do the thing.
 *
 * So the rule is mechanical: every registered tool is named in the
 * constitution. This test is the only thing standing between a new capability
 * and that fate.
 */
const text = agentConstitution('PREAMBLE')

const tools = [
  ...new MemoryCapability({} as never).tools,
  ...new HistoryCapability({} as never).tools,
  ...new SessionsCapability({} as never).tools,
  ...new HandoffCapability({} as never).tools,
  ...new NotetakerCapability({} as never).tools,
  ...new DeliveryCapability({} as never).tools,
].map(tool => tool.name)

test('every registered Agent tool is named in the constitution', () => {
  const unnamed = tools.filter(name => !text.includes(name))
  assert.deepEqual(unnamed, [], 'tools the prose never names cannot be chosen: give each one a sentence and a trigger phrase')
})

test('the four session verbs each carry a trigger phrase in the user\'s voice', () => {
  for (const [verb, phrase] of [
    ['session_resume', 'carry on with that'],
    ['session_fork', 'fork this'],
    ['session_send', 'the way we did it'],
    ['task_create', 'CARRYING WORK SOMEWHERE NEW'],
  ] as const) {
    assert.ok(text.includes(verb), `${verb} is missing`)
    assert.ok(text.includes(phrase), `${verb} has no trigger phrasing (${phrase})`)
  }
})

/** The boundary that decides resume vs relay. Without it every carrying
 *  request collapses into a resume, which delivers the user's words alone —
 *  observed in the field on 2026-09-16. */
test('the prose says what makes a message a relay rather than a resume', () => {
  assert.ok(/anything you learned by reading/i.test(text),
    'the resume rules must hand off to session_send when the message carries what you read')
})
