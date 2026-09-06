import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateContinuationSources } from './sources.ts'
import type { LocatedSession } from './locate.ts'

test('synthesis accepts main conversations only and verifies every provider', async () => {
  const source = { sessionId: 'aaaaaaaa-1111-4222-8333-444444444444', provider: 'codex' as const }
  const located: LocatedSession = { sessionId: source.sessionId, harness: 'codex', cwd: '/project', path: '/rollout.jsonl', provenance: { kind: 'main' } }
  await validateContinuationSources([source], async () => located)
  for (const bad of [null, { ...located, harness: 'claude' as const }, { ...located, provenance: { kind: 'subagent' as const } }, { ...located, provenance: undefined }]) {
    await assert.rejects(validateContinuationSources([source], async () => bad))
  }
})

test('host refuses context with omitted or empty source identities', async () => {
  for (const sources of [undefined, []]) await assert.rejects(validateContinuationSources(sources, async () => null, 'Earlier work established billing migration'))
})
