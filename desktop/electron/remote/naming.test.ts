import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROMPTS } from './config.ts'
import { buildRoutingPrompt, type RoutableTask } from './router.ts'

// Verbs that opened the old examples. A task title starting with one of these
// describes the ACTION; the brief asks for the SUBJECT, because there will be
// several tasks about one subject and the name has to say which subject.
const IMPERATIVE_OPENERS = [
  'open', 'find', 'fix', 'make', 'send', 'check', 'write', 'add', 'update',
  'create', 'build', 'run', 'get', 'summarize', 'draft', 'review', 'delete',
]

/** The example titles a prompt offers, as the model will read them. */
function examplesIn(prompt: string): string[] {
  return [...prompt.matchAll(/"([^"]{3,48})"/g)].map((m) => m[1])
}

test('the task-name prompt asks for the subject rather than the action', () => {
  assert.match(PROMPTS.taskName, /subject/i)
})

test('every example title in the task-name prompt leads with a subject', () => {
  const examples = examplesIn(PROMPTS.taskName)
  assert.ok(examples.length >= 2, 'the prompt must still show examples — they are the real spec')
  for (const ex of examples) {
    const first = ex.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '')
    assert.ok(
      !IMPERATIVE_OPENERS.includes(first),
      `"${ex}" opens with the verb "${first}" — that is the action, not the subject`,
    )
  }
})

test('the task-name prompt still bounds the title, or the card cannot render it', () => {
  assert.match(PROMPTS.taskName, /\b[2-5]\b/, 'a word bound must survive the rewrite')
})

const TASKS: RoutableTask[] = [
  { id: 't1', intent: 'fix the notch freeze', state: 'processing', ageSec: 20, agent: 'claude' },
]

test('the router names a new task by its subject, and says why', () => {
  const p = buildRoutingPrompt('do a thing', TASKS, '/d/decision.json')
  const nameLine = p.split('\n').find((l) => l.startsWith('name (for action "new")')) ?? ''
  assert.ok(nameLine, 'the name contract line must still exist')
  assert.match(nameLine, /subject/i)
})

test('the router is told several tasks will share one subject', () => {
  // This is the whole reason a name must identify rather than describe: on a
  // wall with four unmute tasks, four action phrases are indistinguishable.
  const p = buildRoutingPrompt('do a thing', TASKS, '/d/decision.json')
  const nameLine = p.split('\n').find((l) => l.startsWith('name (for action "new")')) ?? ''
  assert.match(nameLine, /more than one|several|other tasks|same subject/i)
})

test('every example name the router is given leads with a subject', () => {
  const p = buildRoutingPrompt('do a thing', TASKS, '/d/decision.json')
  const nameLine = p.split('\n').find((l) => l.startsWith('name (for action "new")')) ?? ''
  const examples = examplesIn(nameLine)
  assert.ok(examples.length >= 2, 'examples are how the model actually learns the shape')
  for (const ex of examples) {
    const first = ex.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '')
    assert.ok(
      !IMPERATIVE_OPENERS.includes(first),
      `"${ex}" opens with the verb "${first}" — that is the action, not the subject`,
    )
  }
})
