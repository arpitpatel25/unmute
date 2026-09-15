import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentConversationLifecycle } from './lifecycle'
import { AgentJournal } from './journal'
import { AgentConversationStore } from './conversation-store'
import { MemoryCrypto } from './memory/crypto'
import type { AgentInteractionResult, AgentSubmissionContext } from './controller'

async function harness(ceiling = 20) {
  const root = await mkdtemp(join(tmpdir(), 'agent-lifecycle-'))
  const journal = new AgentJournal({ root })
  const store = new AgentConversationStore({ root: join(root, 'conversations'), crypto: new MemoryCrypto({ keyProvider: { getMasterKey: async () => Buffer.alloc(32, 4) } }) })
  const calls: Array<{ text: string; prior?: string; context: AgentSubmissionContext; settle(outcome?: AgentInteractionResult['outcome']): void }> = []
  let reject = false, uncertain = false, refreshes = 0
  let now = 1_000
  const options = { journal, store, now: () => now, ceiling: () => ceiling, selectedProvider: () => 'claude' as const,
    prepareFresh: async () => { refreshes++ }, pin: (_ids: string[]) => {}, close: async (_id: string) => {},
    controller: { async submit(input: { transcript: string; priorRunId?: string }, context: AgentSubmissionContext) {
      const result = (outcome: AgentInteractionResult['outcome']): AgentInteractionResult => ({ interactionId: context.interactionId, agentRunId: context.runId, provider: context.provider, source: 'provider', presentation: 'transient', outcome, text: `answer ${input.transcript}` })
      if (reject || uncertain) return { ...result('failed'), error: { code: uncertain ? 'acceptance-uncertain' as const : 'provider-unavailable' as const, message: 'retained error' } }
      return new Promise<AgentInteractionResult>(resolve => calls.push({ text: input.transcript, prior: input.priorRunId, context, settle: (outcome = 'completed') => resolve(result(outcome)) }))
    } } }
  let lifecycle = new AgentConversationLifecycle(options)
  await lifecycle.initialize()
  async function waitCalls(n: number) { for (let i = 0; calls.length < n && i < 100; i++) await new Promise<void>(r => setTimeout(r, 2)); assert.equal(calls.length, n) }
  async function accept(index: number) {
    const c = calls[index]
    await c.context.onAccepted({ id: c.context.runId, provider: c.context.provider, providerHandle: `handle-${c.context.runId}`, model: 'reported-model', state: 'running', createdAt: 1, lastUserAt: 1, lastActivityAt: 1, providerWorkEnded: false })
  }
  return { root, journal, store, calls, get lifecycle() { return lifecycle }, waitCalls, accept,
    advance: (ms: number) => { now += ms },
    setReject: (value: boolean) => { reject = value }, setUncertain: (value: boolean) => { uncertain = value }, get refreshes() { return refreshes },
    restart: async () => { lifecycle.dispose(); lifecycle = new AgentConversationLifecycle(options); await lifecycle.initialize(); return lifecycle },
    cleanup: async () => { lifecycle.dispose(); await rm(root, { recursive: true, force: true }) } }
}

test('continuous work past twenty stays in the same conversation, preserving draft and replay', async () => {
  const h = await harness()
  try {
    for (let i = 1; i <= 19; i++) {
      const p = h.lifecycle.submit({ transcript: `m${i}`, submissionId: `s${i}` })
      await h.waitCalls(i); await h.accept(i - 1); h.calls[i - 1].settle(); await p
    }
    await h.restart()
    assert.equal(h.lifecycle.view().record.accepted.length, 19)
    const p20 = h.lifecycle.submit({ transcript: 'm20', submissionId: 's20' })
    await h.waitCalls(20); await h.accept(19)
    const queued = await h.lifecycle.enqueue({ transcript: '秘密🙂'.repeat(10000), submissionId: 's21' })
    await h.lifecycle.setDraft('typed during send', 5)
    assert.equal(h.calls.length, 20)
    h.calls[19].settle('interrupted'); await p20
    await h.waitCalls(21)
    assert.equal(h.calls[20].prior, h.calls[19].context.runId)
    assert.equal(h.lifecycle.view().record.accepted.length, 20)
    await h.accept(20)
    assert.equal(h.lifecycle.view().record.accepted.length, 21)
    assert.equal(h.lifecycle.view().snapshot.chat.turns.at(-1)!.text.length, 40000)
    assert.equal(h.lifecycle.view().snapshot.draft.text, 'typed during send')
    h.calls[20].settle(); await queued.completion
    await h.lifecycle.submit({ transcript: 'm1 replay', submissionId: 's1' })
    assert.equal(h.calls.length, 21)
    assert.equal(h.refreshes, 1)
  } finally { await h.cleanup() }
})

test('rejected fresh reset keeps old chat and queue; only explicit retry publishes a pending provider switch', async () => {
  const h = await harness(1)
  try {
    const first = h.lifecycle.submit({ transcript: 'old', submissionId: 'first' })
    await h.waitCalls(1); await h.accept(0); h.calls[0].settle(); await first
    await h.lifecycle.requestProvider('codex')
    h.setReject(true)
    const failed = await h.lifecycle.submit({ transcript: 'next', submissionId: 'next' })
    assert.equal(failed.outcome, 'failed')
    assert.equal(h.lifecycle.view().record.provider, 'claude')
    assert.equal(h.lifecycle.view().snapshot.chat.turns[0].text, 'old')
    assert.equal(h.lifecycle.view().snapshot.queued.length, 1)
    h.setReject(false)
    const retry = h.lifecycle.retry()
    await h.waitCalls(2); await h.accept(1); h.calls[1].settle(); await retry
    assert.equal(h.calls[1].context.carryoverRunId, h.calls[0].context.runId)
    assert.equal(h.lifecycle.view().snapshot.chat.turns[0].text, 'old')
    assert.equal(h.lifecycle.view().record.provider, 'codex')
    assert.match(h.lifecycle.view().snapshot.notice!, /Switched to Codex/)
    assert.equal(h.lifecycle.view().record.accepted.length, 1)
  } finally { await h.cleanup() }
})

test('switching provider discards a recoverable failed submission and accepts the next message on a fresh run', async () => {
  const h = await harness()
  try {
    const first = h.lifecycle.submit({ transcript: 'working context', submissionId: 'first' })
    await h.waitCalls(1); await h.accept(0); h.calls[0].settle(); await first
    h.setReject(true)
    const failed = await h.lifecycle.submit({ transcript: 'retained request', submissionId: 'retained' })
    assert.equal(failed.outcome, 'failed')
    assert.equal(h.lifecycle.view().snapshot.error, 'retained error')

    await h.lifecycle.requestProvider('codex')
    assert.equal(h.lifecycle.view().selectedProvider, 'codex')
    assert.equal(h.lifecycle.view().record.pendingProvider, 'codex')
    assert.equal(h.lifecycle.view().snapshot.error, undefined)
    assert.equal(h.lifecycle.view().snapshot.retryRequired, undefined)
    assert.equal(h.lifecycle.view().snapshot.queued.length, 0)

    h.setReject(false)
    const retry = h.lifecycle.submit({ transcript: 'new provider message', submissionId: 'new-provider-message' })
    await h.waitCalls(2)
    assert.equal(h.calls[1].context.provider, 'codex')
    assert.equal(h.calls[1].prior, undefined)
    assert.equal(h.calls[1].context.carryoverRunId, h.calls[0].context.runId)
    await h.accept(1); h.calls[1].settle(); await retry
  } finally { await h.cleanup() }
})

test('a switch requested during a response waits for settlement and hands recent messages to the new provider', async () => {
  const h = await harness()
  try {
    const first = h.lifecycle.submit({ transcript: 'opening question', submissionId: 'first' })
    await h.waitCalls(1); await h.accept(0); h.calls[0].settle(); await first

    const active = h.lifecycle.submit({ transcript: 'latest question', submissionId: 'active' })
    await h.waitCalls(2); await h.accept(1)
    await h.lifecycle.requestProvider('codex')
    assert.equal(h.lifecycle.view().record.provider, 'claude')
    assert.equal(h.lifecycle.view().record.pendingProvider, 'codex')
    h.calls[1].settle(); await active

    const continued = h.lifecycle.submit({ transcript: 'continue', submissionId: 'continued' })
    await h.waitCalls(3)
    assert.equal(h.calls[2].context.provider, 'codex')
    assert.deepEqual(h.calls[2].context.handoff?.recentTurns.map(turn => [turn.role, turn.text]), [
      ['user', 'opening question'],
      ['agent', 'answer opening question'],
      ['user', 'latest question'],
      ['agent', 'answer latest question'],
    ])
    assert.match(h.calls[2].context.handoff?.summary ?? '', /opening question/)
    await h.accept(2); h.calls[2].settle(); await continued
  } finally { await h.cleanup() }
})

test('a provider handoff copies only the latest six complete exchanges and summarizes older work', async () => {
  const h = await harness()
  try {
    for (let n = 1; n <= 8; n++) {
      const pending = h.lifecycle.submit({ transcript: `question ${n}`, submissionId: `turn-${n}` })
      await h.waitCalls(n); await h.accept(n - 1); h.calls[n - 1].settle(); await pending
    }
    await h.lifecycle.requestProvider('codex')
    const switched = h.lifecycle.submit({ transcript: 'continue', submissionId: 'switched' })
    await h.waitCalls(9)
    const handoff = h.calls[8].context.handoff!
    assert.equal(handoff.recentTurns.length, 12)
    assert.equal(handoff.recentTurns[0].text, 'question 3')
    assert.equal(handoff.recentTurns.at(-1)?.text, 'answer question 8')
    assert.match(handoff.summary, /question 1/)
    assert.match(handoff.summary, /question 2/)
    await h.accept(8); h.calls[8].settle(); await switched
  } finally { await h.cleanup() }
})

test('idle requires the threshold and an empty draft; successful rotation retains visible history', async () => {
  const h = await harness(2)
  try {
    async function turn(text: string, n: number) {
      const pending = h.lifecycle.submit({ transcript: text })
      await h.waitCalls(n); await h.accept(n - 1); h.calls[n - 1].settle(); await pending
    }
    await turn('one', 1)
    h.advance(20 * 60_000)
    await turn('two', 2)
    assert.equal(h.calls[1].prior, h.calls[0].context.runId)
    await h.lifecycle.setDraft('composing', 1)
    h.advance(20 * 60_000)
    await turn('three', 3)
    assert.equal(h.calls[2].prior, h.calls[0].context.runId)
    await h.lifecycle.setDraft('', 2)
    h.advance(20 * 60_000 - 1)
    await turn('four', 4)
    assert.equal(h.calls[3].prior, h.calls[0].context.runId)
    h.advance(20 * 60_000)
    await turn('five', 5)
    assert.equal(h.calls[4].prior, undefined)
    assert.equal(h.calls[4].context.carryoverRunId, h.calls[0].context.runId)
    assert.equal(h.lifecycle.view().snapshot.chat.turns.length, 10)
    assert.equal(h.lifecycle.view().record.accepted.length, 1)
  } finally { await h.cleanup() }
})

test('prepared crash and unobserved write ambiguity fail closed without replay or count guesses', async () => {
  const h = await harness()
  try {
    const pending = h.lifecycle.submit({ transcript: 'unknown', submissionId: 'unknown' })
    await h.waitCalls(1)
    await h.restart()
    assert.equal(h.lifecycle.view().record.phase, 'recovery-required')
    assert.equal(h.lifecycle.view().record.accepted.length, 0)
    await h.lifecycle.retry()
    assert.equal(h.calls.length, 1)
    await assert.rejects(h.accept(0), /stale|stopped/i)
    h.calls[0].settle(); await pending
  } finally { await h.cleanup() }
})

test('restart at threshold waits for idle before rotating and carries prior run context', async () => {
  const h = await harness(1)
  try {
    const pending = h.lifecycle.submit({ transcript: 'boundary', submissionId: 'boundary' })
    await h.waitCalls(1); await h.accept(0)
    await h.restart()
    assert.equal(h.lifecycle.view().record.phase, 'reset-due')
    assert.equal(h.lifecycle.view().record.accepted[0].outcome, 'interrupted')
    h.advance(20 * 60_000)
    const next = h.lifecycle.submit({ transcript: 'fresh' })
    await h.waitCalls(2); assert.equal(h.calls[1].prior, undefined)
    assert.equal(h.calls[1].context.carryoverRunId, h.calls[0].context.runId)
    await h.accept(1); h.calls[1].settle(); await next
    h.calls[0].settle(); await pending
  } finally { await h.cleanup() }
})

test('missing established journal never silently starts an empty conversation', async () => {
  const h = await harness()
  try {
    await unlink(join(h.root, 'agent-journal.json'))
    await assert.rejects(h.restart(), /restore|journal|recovery/i)
  } finally { await h.cleanup() }
})

test('accepted replay is idempotent in flight and after failed completion; rejected retry counts once', async () => {
  const h = await harness()
  try {
    h.setReject(true)
    await h.lifecycle.submit({ transcript: 'first', submissionId: 'same' })
    assert.equal(h.lifecycle.view().record.accepted.length, 0)
    h.setReject(false)
    const retry = h.lifecycle.retry()
    await h.waitCalls(1); await h.accept(0)
    const replay = h.lifecycle.submit({ transcript: 'retry body', submissionId: 'same' })
    h.calls[0].settle('failed')
    await retry; await replay
    await h.lifecycle.submit({ transcript: 'again', submissionId: 'same' })
    assert.equal(h.calls.length, 1)
    assert.equal(h.lifecycle.view().record.accepted.length, 1)
  } finally { await h.cleanup() }
})

test('write ambiguity and acceptance snapshot failure both preserve prepared input and block replay', async () => {
  for (const mode of ['uncertain', 'storage'] as const) {
    const h = await harness()
    try {
      if (mode === 'uncertain') h.setUncertain(true)
      const p = h.lifecycle.submit({ transcript: 'retained', submissionId: 'retained' })
      if (mode === 'storage') {
        await h.waitCalls(1)
        const write = h.store.write.bind(h.store)
        h.store.write = async () => { h.store.write = write; throw new Error('disk full') }
        await assert.rejects(h.accept(0), /uncertain/)
        // The controller returns the acceptance uncertainty reported by the supervisor.
        h.calls[0].settle('failed')
      }
      await p
      assert.equal(h.lifecycle.view().record.accepted.length, 0)
      assert.equal(h.lifecycle.view().snapshot.queued[0].input.transcript, 'retained')
      assert.equal(h.lifecycle.view().record.phase, 'recovery-required')
      await h.lifecycle.retry(); assert.equal(h.calls.length, mode === 'uncertain' ? 0 : 1)
    } finally { await h.cleanup() }
  }
})

test('failed initial publication remains retryable on restart before establishment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bootstrap-'))
  const journal = new AgentJournal({ root })
  const store = new AgentConversationStore({ root: join(root, 'conversations'), crypto: new MemoryCrypto({ keyProvider: { getMasterKey: async () => Buffer.alloc(32, 8) } }) })
  const options = { journal, store, selectedProvider: () => 'claude' as const, prepareFresh: async () => {}, pin: () => {}, close: async () => {}, controller: { submit: async (): Promise<AgentInteractionResult> => { throw new Error('Bootstrap must not dispatch') } } }
  let lifecycle = new AgentConversationLifecycle(options)
  try {
    const checkpoint = journal.checkpointConversation.bind(journal)
    journal.checkpointConversation = async () => { throw new Error('Initial publication failed') }
    await assert.rejects(lifecycle.initialize(), /Initial publication failed/)
    assert.equal(await store.established(), false)
    lifecycle.dispose()
    journal.checkpointConversation = checkpoint
    lifecycle = new AgentConversationLifecycle(options)
    await lifecycle.initialize()
    assert.equal(await store.established(), true)
    assert.equal(lifecycle.view().record.accepted.length, 0)
    await unlink(join(root, 'agent-journal.json'))
    lifecycle.dispose(); lifecycle = new AgentConversationLifecycle(options)
    await assert.rejects(lifecycle.initialize(), /established.*missing/)
  } finally { lifecycle.dispose(); await rm(root, { recursive: true, force: true }) }
})

for (const failedPublication of ['snapshot', 'journal'] as const) {
  test(`completed response survives ${failedPublication} checkpoint failure and settlement retry without provider replay`, async () => {
    const h = await harness()
    try {
      const transcript = 'Full answer 🙂'.repeat(3000)
      const pending = h.lifecycle.submit({ transcript, submissionId: 'settled' })
      await h.waitCalls(1); await h.accept(0)
      if (failedPublication === 'snapshot') {
        const write = h.store.write.bind(h.store)
        h.store.write = async () => { h.store.write = write; throw new Error('Snapshot unavailable') }
      } else {
        const checkpoint = h.journal.checkpointConversation.bind(h.journal)
        h.journal.checkpointConversation = async () => { h.journal.checkpointConversation = checkpoint; throw new Error('Journal unavailable') }
      }
      h.calls[0].settle()
      const completed = await pending
      assert.equal(completed.text, `answer ${transcript}`)
      assert.equal(h.lifecycle.view().snapshot.chat.turns.at(-1)?.text, `answer ${transcript}`)
      assert.equal(h.lifecycle.view().snapshot.settlementPending, true)
      if (failedPublication === 'snapshot') {
        await h.lifecycle.setDraft('newer draft', 9)
        await h.lifecycle.retry()
        assert.equal(h.lifecycle.view().snapshot.draft.text, 'newer draft')
      } else await h.restart()
      assert.equal(h.lifecycle.view().snapshot.settlementPending, undefined)
      assert.equal(h.lifecycle.view().snapshot.chat.turns.length, 2)
      assert.equal(h.lifecycle.view().snapshot.results?.settled.text, `answer ${transcript}`)
      assert.equal(h.lifecycle.view().record.accepted[0].outcome, 'completed')
      await h.lifecycle.submit({ transcript: 'replay', submissionId: 'settled' })
      assert.equal(h.calls.length, 1)
    } finally { await h.cleanup() }
  })
}

/**
 * ONE conversation at a time, and a way to end it.
 *
 * Before this the only exits were twenty turns or six hours idle, so a chat
 * that had gone somewhere wrong could only be escaped by waiting. Starting a
 * new one REPLACES the old — it is not an additional conversation — so the
 * next turn must carry no priorRunId, which is what makes the controller take
 * supervisor.start() instead of resume().
 */
test('discarding ends the conversation and the next turn starts clean', async () => {
  const h = await harness()
  try {
    const first = h.lifecycle.submit({ transcript: 'before', submissionId: 'b1' })
    await h.waitCalls(1); await h.accept(0); h.calls[0].settle(); await first
    assert.equal(h.calls[0].prior, undefined, 'the very first turn has no prior')

    const outcome = await h.lifecycle.discard()
    assert.deepEqual(outcome, { discarded: true })

    // Checked HERE, before anything new is said: the point is that the old
    // conversation is gone, not that a later one looks small.
    const emptied = h.lifecycle.view()
    assert.deepEqual(emptied.snapshot.chat.turns, [], 'the old turns are gone, not carried over')
    assert.equal(emptied.record.runId, null, 'nothing is left to resume into')
    assert.deepEqual(emptied.record.accepted, [], 'the turn count restarts, so the ceiling is not inherited')

    const second = h.lifecycle.submit({ transcript: 'after', submissionId: 'a1' })
    await h.waitCalls(2); await h.accept(1); h.calls[1].settle(); await second
    assert.equal(h.calls[1].prior, undefined, 'a discarded conversation must not be resumed into')

    // The persona is re-read on the way out, so an edited prompt takes effect
    // on the conversation the person just started rather than the next one.
    assert.ok(h.refreshes >= 1, 'discard must prepare a fresh constitution')
    const texts = h.lifecycle.view().snapshot.chat.turns.map(t => t.text)
    assert.ok(texts.some(t => t.includes('after')), 'the new conversation holds what was said after')
    assert.ok(!texts.some(t => t.includes('before')), 'and nothing from the conversation that was ended')
  } finally { await h.cleanup() }
})

test('a conversation is never discarded out from under a running turn', async () => {
  const h = await harness()
  try {
    const inFlight = h.lifecycle.submit({ transcript: 'working', submissionId: 'w1' })
    await h.waitCalls(1); await h.accept(0)
    const refused = await h.lifecycle.discard()
    assert.equal(refused.discarded, false)
    assert.match(refused.reason ?? '', /still running/)
    h.calls[0].settle(); await inFlight
    // Once it lands, the same request is honoured.
    assert.equal((await h.lifecycle.discard()).discarded, true)
  } finally { await h.cleanup() }
})

test('a discarded conversation stays discarded across a restart', async () => {
  const h = await harness()
  try {
    const p = h.lifecycle.submit({ transcript: 'one', submissionId: 'o1' })
    await h.waitCalls(1); await h.accept(0); h.calls[0].settle(); await p
    await h.lifecycle.discard()
    const revived = await h.restart()
    const next = revived.submit({ transcript: 'two', submissionId: 't1' })
    await h.waitCalls(2); await h.accept(1); h.calls[1].settle(); await next
    assert.equal(h.calls[1].prior, undefined, 'the discard must survive a runtime restart')
  } finally { await h.cleanup() }
})
