import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentRuntimeRoot, AGENT_RUNTIME_SCHEMA } from './agent-schema'

test('provider switching uses a new worker generation while retaining the shared Agent data root', () => {
  assert.equal(AGENT_RUNTIME_SCHEMA, 'agent-metadata-v2')
  assert.equal(agentRuntimeRoot('/app-data'), '/app-data/persistent-runtime-agent-metadata-v2')
})
