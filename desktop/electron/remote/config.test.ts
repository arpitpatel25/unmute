import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODELS, DOER_MODELS, MODEL_CATALOG, isDoerModel, PROMPTS } from './config.ts'

// This refactor MOVED model choices + the two static prompts into config.ts
// with the promise that every value is BYTE-IDENTICAL to what was inline before
// (a pure centralization — no behavior change). These pins are the guard: if a
// value ever drifts, this test fails loudly rather than silently changing what
// the LLM/executor receives.

test('default catalog is the Claude Code /model aliases, fast → capable', () => {
  assert.deepEqual([...DOER_MODELS], ['default', 'haiku', 'sonnet', 'opus', 'opusplan'])
  // DOER_MODELS is derived from the catalog — they must stay in lockstep.
  assert.deepEqual(MODEL_CATALOG.map((m) => m.id), [...DOER_MODELS])
  // Every catalog entry is renderable (id + label).
  for (const c of MODEL_CATALOG) {
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

test('task-name prompt is byte-identical to the original', () => {
  assert.equal(
    PROMPTS.taskName,
    'You name a task with a SHORT title for a session list in a UI. ' +
      'Reply with ONLY a 2-5 word title in plain text — no quotes, no punctuation, no trailing period. ' +
      'Capture the essence, e.g. "Twitter strategy folder summary", "Open Dodo women\'s page", "Fresh Claude session".',
  )
})
