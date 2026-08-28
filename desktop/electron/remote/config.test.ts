import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODELS, DOER_MODELS, MODEL_CATALOG, modelsFor, isDoerModel, PROMPTS } from './config.ts'

// This refactor MOVED model choices + the two static prompts into config.ts
// with the promise that every value is BYTE-IDENTICAL to what was inline before
// (a pure centralization — no behavior change). These pins are the guard: if a
// value ever drifts, this test fails loudly rather than silently changing what
// the LLM/executor receives.

test('default catalog is the Claude Code /model aliases, fast → capable', () => {
  assert.deepEqual([...DOER_MODELS], ['default', 'haiku', 'sonnet', 'opus', 'opusplan'])
  // DOER_MODELS is derived from the catalog — they must stay in lockstep.
  // Scoped to Claude: the catalog now carries Codex entries too, and both
  // backends legitimately offer an id called 'default'.
  assert.deepEqual(modelsFor('claude').map((m) => m.id), [...DOER_MODELS])
  // Every catalog entry is renderable (id + label).
  for (const c of modelsFor('claude')) {
    assert.ok(c.id.length > 0 && c.label.length > 0, `${c.id} has id+label`)
  }
})

test('model choices match the pre-refactor inline literals', () => {
  assert.equal(MODELS.doerDefault, 'sonnet') // init.ts settings default + all `|| 'sonnet'` fallbacks
  assert.equal(MODELS.router, 'sonnet')      // routerExecutorFactory (pinned)
  assert.equal(MODELS.librarian, 'opus')     // librarianExecutorFactory (pinned)
})

test('every configured model is a valid doer tier', () => {
  for (const m of Object.values(MODELS)) assert.ok(isDoerModel(m), `${m} is a valid tier`)
})

test('isDoerModel narrows to the compiled catalog aliases', () => {
  assert.equal(isDoerModel('haiku'), true)
  assert.equal(isDoerModel('sonnet'), true)
  assert.equal(isDoerModel('opus'), true)
  assert.equal(isDoerModel('default'), true)
  assert.equal(isDoerModel('opusplan'), true)
  assert.equal(isDoerModel('gpt-4'), false)
  assert.equal(isDoerModel('claude-opus-4-8'), false) // a pinned id — valid only if config adds it to the catalog
  assert.equal(isDoerModel(''), false)
  assert.equal(isDoerModel(undefined), false)
  assert.equal(isDoerModel(null), false)
})

test('intent-cleanup prompt is byte-identical to the original', () => {
  assert.equal(
    PROMPTS.intentCleanup,
    'You clean up a voice transcript into a single clear command for a computer assistant. ' +
      'Rules: remove filler ("uh", "um", "like"), resolve self-corrections (keep the final intent), ' +
      'fix obvious speech-to-text errors, and output ONE concise imperative sentence. ' +
      'Do NOT add steps, do NOT answer or perform the task, do NOT ask questions. ' +
      'Output only the cleaned command, nothing else.',
  )
})

test('task-name prompt is pinned — it is the compiled floor, and a silent edit changes every title', () => {
  // The pin exists to catch ACCIDENTAL drift in a value that ships in the
  // bundle and is overridable at runtime. It was updated deliberately on
  // 2026-08-27, when naming moved from action-led to subject-led; the
  // properties that actually matter are asserted in naming.test.ts.
  assert.equal(
    PROMPTS.taskName,
    'You name a task with a SHORT title for a session list in a UI. ' +
    'Reply with ONLY a 2-5 word title in plain text — no quotes, no punctuation, no trailing period. ' +
    'Lead with the SUBJECT — the thing the work is about — and never with the action being taken on it. ' +
    'The user will have several tasks about the same subject, so the title must identify which subject it is, ' +
    'adding a distinguishing detail only after the subject is clear. ' +
    'e.g. "Dodo checkout page", "Twitter strategy folder", "Notch freeze on wake", "Unmute pricing model".',
  )
})

test('each backend gets its own models, and an untagged entry still means Claude', () => {
  const claude = modelsFor('claude').map((m) => m.id)
  assert.ok(claude.includes('opus'))
  // A BACKEND THE CATALOGUE DOES NOT SPEAK FOR GETS NOTHING, never Claude's
  // list under its name. A Claude id handed to Codex is not an error you would
  // see: `-c model="opus"` is valid TOML for a model that does not exist, so it
  // fails at the API rather than at the picker.
  assert.deepEqual(modelsFor('codex'), [])
  // Tagged entries are filtered by tag, whoever supplies them (config can).
  const tagged = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B', provider: 'codex' as const },
  ]
  assert.deepEqual(modelsFor('claude', tagged).map((m) => m.id), ['a'])
  assert.deepEqual(modelsFor('codex', tagged).map((m) => m.id), ['b'])
  // Absent provider must keep meaning Claude: the catalog predates a second CLI
  // and the persisted `model` setting carries no provider key.
  assert.equal(modelsFor(undefined).length, claude.length)
})
