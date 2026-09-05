import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UnmuteAgentController } from './controller'
import { InteractionAttachmentHandles } from './memory/attachments'
import { CapabilityRegistry } from './capabilities/registry'
import type { AgentResumeInput, AgentRunInput, SupervisedAgentSession } from './supervisor'

test('controller uses actual resumed provider and never injects another run transcript into a fresh turn', async () => {
  const transcripts: string[] = []
  const session = (input: AgentRunInput | AgentResumeInput): SupervisedAgentSession => {
    transcripts.push(input.transcript)
    return { runId: 'old', provider: 'codex', run: { id: 'old', provider: 'codex', state: 'complete', createdAt: 1, lastUserAt: 1, lastActivityAt: 1, providerWorkEnded: true }, handle: { provider: 'codex', opaqueId: 'exact' }, activity: empty(), completion: Promise.resolve({ outcome: 'completed', finalText: 'answer' }) }
  }
  const controller = new UnmuteAgentController({
    supervisor: { start: (async (input: AgentRunInput) => session(input)) as never, resume: async (_id, input) => session(input), recentExchanges: async () => [{ runId: 'old', interactionId: 'before', at: 1, outcome: 'completed', summary: 'TRANSIENT_OLD' }, { runId: 'other', interactionId: 'other', at: 1, outcome: 'completed', summary: 'TRANSIENT_OTHER' }] },
    tokens: { closeRun() {} }, attachmentHandles: new InteractionAttachmentHandles(), capabilities: new CapabilityRegistry([]), journal: { appendExchange: async () => {} },
    selectedProvider: () => 'claude', runtime: () => ({ cwd: '/canonical/runtime', constitutionPath: '/canonical/constitution.md', environment: {}, mcp: { endpoint: 'http://127.0.0.1/mcp', config: 'strict' } }),
  })
  const resumed = await controller.submit({ transcript: 'follow up', priorRunId: 'old' })
  assert.equal(resumed.provider, 'codex')
  assert.match(transcripts[0], /TRANSIENT_OLD/)
  assert.doesNotMatch(transcripts[0], /TRANSIENT_OTHER/)
  await controller.submit({ transcript: 'fresh' })
  assert.doesNotMatch(transcripts[1], /TRANSIENT_OLD|TRANSIENT_OTHER/)
  controller.dispose()
})
async function* empty() {}
