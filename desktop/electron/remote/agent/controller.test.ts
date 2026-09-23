import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UnmuteAgentController, providerTranscript } from './controller'
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
  await controller.submit({ transcript: 'continue the task' }, {
    interactionId: 'handover', runId: 'new', provider: 'claude', carryoverRunId: 'old', onAccepted: async () => {},
    handoff: {
      fromProvider: 'codex',
      summary: 'The earlier conversation established the launch constraints.',
      recentTurns: [
        { role: 'user', text: 'Use the signed build.' },
        { role: 'agent', text: 'The signed build is installed.' },
      ],
    },
  })
  assert.match(transcripts[2], /TRANSIENT_OLD/)
  assert.doesNotMatch(transcripts[2], /TRANSIENT_OTHER/)
  assert.match(transcripts[2], /earlier conversation established the launch constraints/)
  assert.match(transcripts[2], /User: Use the signed build\./)
  assert.match(transcripts[2], /Assistant: The signed build is installed\./)
  controller.dispose()
})

// A routine run (executor.ts) supplies its own cwd/constitution/mcp and its
// own read-only tool list instead of the live Agent's. Both overrides must
// win outright — options.runtime() and options.capabilities.tools() must not
// even run, since the live Agent's cwd is not one a routine should touch.
test('a context runtime/capabilities override wins outright; the live-Agent options are never called', async () => {
  let runtimeCalls = 0
  let capabilitiesCalls = 0
  const seen: { cwd?: string; transcript?: string } = {}
  const session = (input: AgentRunInput | AgentResumeInput): SupervisedAgentSession => {
    seen.cwd = input.cwd
    seen.transcript = input.transcript
    return {
      runId: 'r', provider: 'claude',
      run: { id: 'r', provider: 'claude', state: 'complete', createdAt: 1, lastUserAt: 1, lastActivityAt: 1, providerWorkEnded: true },
      handle: { provider: 'claude', opaqueId: 'h' }, activity: empty(),
      completion: Promise.resolve({ outcome: 'completed', finalText: 'ok' }),
    }
  }
  const controller = new UnmuteAgentController({
    supervisor: { start: (async (input: AgentRunInput) => session(input)) as never, resume: async (_id, input) => session(input), recentExchanges: async () => [] },
    tokens: { closeRun() {} },
    attachmentHandles: new InteractionAttachmentHandles(),
    capabilities: { tools: () => { capabilitiesCalls += 1; return [{ name: 'live_tool', description: 'live' }] } },
    journal: { appendExchange: async () => {} },
    selectedProvider: () => 'claude',
    runtime: () => {
      runtimeCalls += 1
      return { cwd: '/live', constitutionPath: '/live/constitution.md', environment: {}, mcp: { endpoint: 'http://127.0.0.1/mcp', config: 'strict' } }
    },
  })
  const override = { cwd: '/routines/run-1', constitutionPath: '/routines/run-1/constitution.md', environment: {}, mcp: { endpoint: 'http://127.0.0.1/mcp', config: 'strict' } }
  await controller.submit(
    { transcript: 'do the routine' },
    { interactionId: 'i1', runId: 'r', provider: 'claude', onAccepted: async () => {}, runtime: override, capabilities: [{ name: 'routine_runs', description: 'read-only' }] },
  )
  assert.equal(runtimeCalls, 0, 'options.runtime() must not run when a context override is supplied')
  assert.equal(capabilitiesCalls, 0, 'options.capabilities.tools() must not run when a context override is supplied')
  assert.equal(seen.cwd, '/routines/run-1')
  assert.match(seen.transcript ?? '', /routine_runs: read-only/)
  controller.dispose()
})
async function* empty() {}

test('per-turn Agent prompt does not copy MCP tool descriptions into conversation history', () => {
  const prompt = providerTranscript(
    { transcript: 'Find the earlier task', attachments: [] }, [], [],
    [{ name: 'index_search', description: 'LONG_TOOL_DESCRIPTION_SHOULD_LIVE_IN_MCP' }],
  )
  assert.match(prompt, /Find the earlier task/)
  assert.doesNotMatch(prompt, /LONG_TOOL_DESCRIPTION_SHOULD_LIVE_IN_MCP/)
})

test('controller supplies bounded local history candidates before the Agent runs', async () => {
  let transcript = ''
  const controller = new UnmuteAgentController({
    supervisor: {
      start: async input => {
        transcript = input.transcript
        return { runId: 'r', provider: 'claude', run: { id: 'r', provider: 'claude', state: 'complete', createdAt: 1, lastUserAt: 1, lastActivityAt: 1, providerWorkEnded: true }, handle: { provider: 'claude', opaqueId: 'h' }, activity: empty(), completion: Promise.resolve({ outcome: 'completed', finalText: 'Found it.' }) }
      },
      resume: async () => { throw new Error('not used') }, recentExchanges: async () => [],
    },
    tokens: { closeRun() {} }, attachmentHandles: new InteractionAttachmentHandles(),
    capabilities: new CapabilityRegistry([]), journal: { appendExchange: async () => {} },
    selectedProvider: () => 'claude',
    runtime: () => ({ cwd: '/runtime', constitutionPath: '/constitution.md', environment: {}, mcp: { endpoint: 'http://127.0.0.1/mcp', config: 'strict' } }),
    prefetchHistory: async () => ({ status: 'matched', text: 'BOUNDED_LOCAL_MATCH', terms: 2, matchedSessions: 1 }),
  })
  await controller.submit({ transcript: 'Find the earlier session' })
  assert.match(transcript, /BOUNDED_LOCAL_MATCH/)
  controller.dispose()
})
