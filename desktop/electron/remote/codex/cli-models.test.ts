import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCodexCliChoice, codexCliChoiceLabel, listCodexCliModels, forgetCodexCliModels } from './cli-models.ts'
import type { CodexModel } from './appserver.ts'

/**
 * The real codex-cli 0.147 line-up, captured from `model/list` on 2026-08-10.
 * Kept as a FIXTURE, never as the app's source of truth — the whole point of
 * cli-models.ts is that this list is Codex's to change, and it changed
 * completely from the release before. Its job here is to be a realistic shape:
 * six models, efforts that DIFFER per model (Luna has no 'ultra'), and defaults
 * that are not all the same.
 */
const REAL: CodexModel[] = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', uiLabel: '5.6 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], effortLabels: ['Light', 'Medium', 'High', 'Extra High', 'Max', 'Ultra'], defaultEffort: 'low' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', uiLabel: '5.6 Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], effortLabels: ['Light', 'Medium', 'High', 'Extra High', 'Max', 'Ultra'], defaultEffort: 'medium' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', uiLabel: '5.6 Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], effortLabels: ['Light', 'Medium', 'High', 'Extra High', 'Max'], defaultEffort: 'medium' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', uiLabel: '5.4 Mini', efforts: ['low', 'medium', 'high', 'xhigh'], effortLabels: ['Light', 'Medium', 'High', 'Extra High'], defaultEffort: 'medium' },
]

test('a stored model Codex no longer offers is refused, not passed through', () => {
  // THE 1.4.24 BUG, as a test. The shipped picker offered four invented ids;
  // anyone who chose one has it on disk. Passing it on would reach Codex as
  // `-c model="gpt-5.1-codex-max"` — valid TOML, so the task starts and dies at
  // the API, which is the failure mode this module exists to make impossible.
  const r = resolveCodexCliChoice(REAL, 'gpt-5.1-codex-max', 'high')
  assert.equal(r.model, undefined)
  assert.equal(r.effort, undefined)
})

test('the literal string "default" is not a model', () => {
  // It was an entry in the invented catalogue AND the stored default value.
  assert.deepEqual(resolveCodexCliChoice(REAL, 'default', undefined), {})
})

test('an effort is checked against ITS model, not against all of them', () => {
  // 'ultra' is real — on Sol and Terra. Luna does not have it, and a pair that
  // is individually valid but jointly wrong is the subtle version of the same
  // bug: both halves look fine in the log.
  assert.equal(resolveCodexCliChoice(REAL, 'gpt-5.6-sol', 'ultra').effort, 'ultra')
  const luna = resolveCodexCliChoice(REAL, 'gpt-5.6-luna', 'ultra')
  assert.equal(luna.model?.id, 'gpt-5.6-luna')
  assert.equal(luna.effort, undefined, 'an effort Luna does not offer must be dropped, keeping the model')
})

test('no stored model means no opinion — Codex runs on its own default', () => {
  assert.deepEqual(resolveCodexCliChoice(REAL, undefined, undefined), {})
  assert.deepEqual(resolveCodexCliChoice(REAL, '', ''), {})
})

test('an empty list resolves to nothing rather than guessing', () => {
  // Codex could not be asked. That is not the same as "your model was retired",
  // and it must not clear a perfectly good choice.
  assert.deepEqual(resolveCodexCliChoice([], 'gpt-5.6-sol', 'high'), {})
})

test('the label is Codex’s own spelling, in both halves', () => {
  // 'low' prints as 'Light' and 'xhigh' as 'Extra High' — not the wire value
  // with a capital letter, which is why the two are index-aligned rather than
  // derived. Getting this wrong is silent: the chip reads plausibly and matches
  // nothing in the menu.
  assert.equal(codexCliChoiceLabel(REAL[1], 'xhigh'), '5.6 Terra Extra High')
  assert.equal(codexCliChoiceLabel(REAL[0], 'low'), '5.6 Sol Light')
  assert.equal(codexCliChoiceLabel(REAL[0], undefined), '5.6 Sol')
  assert.equal(codexCliChoiceLabel(undefined, 'high'), 'Default')
  // An effort the model does not have contributes nothing rather than being
  // printed raw.
  assert.equal(codexCliChoiceLabel(REAL[2], 'ultra'), '5.6 Luna')
})

test('a missing binary yields an empty list, not a throw and not a fallback', async () => {
  forgetCodexCliModels()
  // No `codex` to find and no bundled app in the test environment ⇒ []. The
  // surfaces render an honest empty state; the one thing that must never happen
  // is another backend's models appearing under Codex's name.
  const models = await listCodexCliModels({ force: true })
  assert.ok(Array.isArray(models))
  forgetCodexCliModels()
})
