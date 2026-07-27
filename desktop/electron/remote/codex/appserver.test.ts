import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseModels, matchCurrent, listCodexModels } from './appserver'

/** A trimmed copy of a real `model/list` response from Codex. */
const RAW = [
  {
    model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: 'Latest frontier agentic coding model.',
    hidden: false, defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' }, { reasoningEffort: 'max' }, { reasoningEffort: 'ultra' },
    ],
  },
  {
    model: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', hidden: false, defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' }, { reasoningEffort: 'max' },
    ],
  },
  { model: 'gpt-5.4-mini', displayName: 'GPT-5.4-Mini', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
  { model: 'gpt-internal', displayName: 'Internal', hidden: true, supportedReasoningEfforts: [] },
]

describe('parseModels', () => {
  test('keeps id, label and per-model efforts', () => {
    const m = parseModels(RAW)
    assert.equal(m[0].id, 'gpt-5.6-sol')
    assert.equal(m[0].label, 'GPT-5.6-Sol')
    assert.deepEqual(m[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    assert.equal(m[0].defaultEffort, 'low')
  })

  test('EFFORTS ARE PER MODEL — Luna offers five where Sol offers six', () => {
    const m = parseModels(RAW)
    assert.equal(m.find((x) => x.id === 'gpt-5.6-sol')!.efforts.length, 6)
    assert.equal(m.find((x) => x.id === 'gpt-5.6-luna')!.efforts.length, 5)
  })

  test('hidden models are never offered', () => {
    assert.equal(parseModels(RAW).some((m) => m.id === 'gpt-internal'), false)
  })

  test('rows with no id are dropped rather than rendered blank', () => {
    assert.deepEqual(parseModels([{ displayName: 'ghost' }] as never), [])
  })

  test('a malformed payload yields an empty catalogue, not a throw', () => {
    assert.deepEqual(parseModels([null, undefined, {}] as never), [])
  })
})

describe('matchCurrent', () => {
  const models = parseModels(RAW)

  test('reads model and effort out of the button label', () => {
    assert.deepEqual(matchCurrent('5.6 Sol High', models), { model: 'GPT-5.6-Sol', effort: 'high' })
  })

  test('tolerates the GPT prefix and hyphens', () => {
    assert.deepEqual(matchCurrent('GPT-5.6-Luna Max', models), { model: 'GPT-5.6-Luna', effort: 'max' })
  })

  test('prefers the LONGEST match so a shorter name cannot shadow it', () => {
    // "5.6 Luna" must not be claimed by a hypothetical "5.6" entry.
    assert.equal(matchCurrent('5.6 Luna xhigh', models).model, 'GPT-5.6-Luna')
  })

  test('an effort the model does not support is not reported', () => {
    // Mini offers only `low`; "ultra" belongs to Sol.
    assert.equal(matchCurrent('5.4 Mini ultra', models).effort, undefined)
  })

  test('an unknown or absent label reports nothing rather than guessing', () => {
    assert.deepEqual(matchCurrent(null, models), {})
    assert.deepEqual(matchCurrent('Something Else', models), {})
  })
})

describe('listCodexModels', () => {
  test('a missing binary resolves EMPTY — never throws, never hangs', async () => {
    const out = await listCodexModels({ bin: '/nonexistent/codex', timeoutMs: 1500 })
    assert.deepEqual(out, [])
  })

  test('a binary that says nothing times out to empty', async () => {
    // `cat` speaks no JSON-RPC, so initialize is never answered.
    const out = await listCodexModels({ bin: '/bin/cat', timeoutMs: 600 })
    assert.deepEqual(out, [])
  })
})
