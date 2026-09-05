import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentJournal, type JournalAgentRun } from './journal'

test('additive conversation checkpoint atomically publishes acceptance and pins current run against eviction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-journal-'))
  try {
    const journal = new AgentJournal({ root, maxRuns: 1 })
    const run: JournalAgentRun = { id: 'r1', provider: 'codex', providerHandle: 'thread-1', state: 'complete', createdAt: 1, lastUserAt: 1, lastActivityAt: 1, completedAt: 2, providerWorkEnded: true }
    await journal.upsertRun(run)
    assert.equal((await journal.read()).conversation, undefined)
    await journal.checkpointConversation({ conversation: { generation: 1, phase: 'ready', runId: 'r1', provider: 'codex', effort: 'medium', ceiling: 20, accepted: [{ submissionId: 's1', interactionId: 'i1', acceptedAt: 1 }], snapshotId: 'snapshot1' }, runs: [run] })
    await journal.upsertRun({ ...run, id: 'r2', lastActivityAt: 3 })
    const restored = await new AgentJournal({ root }).read()
    assert.equal(restored.conversation?.accepted.length, 1)
    assert.deepEqual(restored.runs.map(r => r.id), ['r1'])
    assert.throws(() => journal.checkpointConversation({ conversation: { ...restored.conversation!, accepted: [...restored.conversation!.accepted, ...restored.conversation!.accepted] }, runs: [] }))
    assert.equal((await journal.read()).conversation?.accepted.length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
