import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRunSupervisor } from './supervisor'
import { AgentJournal } from './journal'
import { AgentTokenStore } from './tokens'
import type { AgentProvider, AgentStartInput } from './provider'

test('pinned exact provider survives idle/restart with renewed credentials and missing handle fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-supervisor-'))
  let now = 1000
  const journal = new AgentJournal({ root })
  const tokens = new AgentTokenStore({ now: () => now })
  const launches: AgentStartInput[] = []
  const provider: AgentProvider = {
    id: 'codex', probe: async () => ({ provider: 'codex', available: true }),
    async start(input) { launches.push(input); return { handle: { provider: 'codex', opaqueId: 'exact-thread' }, model: 'reported-model', activity: empty(), completion: Promise.resolve({ outcome: 'completed', finalText: 'done' }) } },
    async resume(handle, input) { assert.equal(handle.opaqueId, 'exact-thread'); return this.start(input) },
    interrupt: async () => {}, close: async () => {},
  }
  const options = { providers: { codex: provider }, journal, tokenStore: tokens, now: () => now, timers: { setInterval: () => 0, clearInterval: () => {} } }
  let supervisor = new AgentRunSupervisor(options)
  const turn = { interactionId: 'i1', cwd: '/canonical/runtime', transcript: 'hello', constitutionPath: '/canonical/runtime/constitution.md', environment: { PATH: '/bin' }, mcp: { endpoint: 'http://127.0.0.1/mcp', config: 'strict' }, requireObservedAcceptance: true }
  try {
    const session = await supervisor.start({ ...turn, runId: 'run', onAccepted: async run => journal.checkpointConversation({ runs: [run], conversation: { generation: 1, phase: 'sending', runId: 'run', provider: 'codex', model: run.model, effort: 'medium', ceiling: 20, snapshotId: 'snapshot', accepted: [{ submissionId: 's1', interactionId: 'i1', acceptedAt: now }] } }) }, 'codex')
    await session.completion
    supervisor.pinConversation(['run'])
    now += 99_000_000
    assert.deepEqual(await supervisor.reap(), [])
    await supervisor.dispose()
    supervisor = new AgentRunSupervisor(options)
    const resumed = await supervisor.resume('run', { ...turn, interactionId: 'i2' })
    assert.equal(resumed.provider, 'codex')
    assert.equal(launches[1].model, 'reported-model')
    assert.notEqual(launches[0].mcp.token, launches[1].mcp.token)
    assert.equal(tokens.resolve(launches[0].mcp.token), null)
    await resumed.completion
    await journal.upsertRun({ id: 'broken', provider: 'codex', state: 'failed', providerWorkEnded: true, createdAt: now, lastActivityAt: now, lastUserAt: now })
    await supervisor.dispose(); supervisor = new AgentRunSupervisor(options)
    await assert.rejects(supervisor.resume('broken', turn), /unavailable/)
    assert.equal(launches.length, 2)
  } finally { await supervisor.dispose(); await rm(root, { recursive: true, force: true }) }
})
async function* empty() {}
