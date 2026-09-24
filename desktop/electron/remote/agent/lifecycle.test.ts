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
  const interrupts: string[] = []
  const closed: string[] = []
  let reject = false, uncertain = false, refreshes = 0
  let contextTokens: number | undefined
  let interruptFails: string | null = null
  let now = 1_000
  const options = { journal, store, now: () => now, ceiling: () => ceiling, selectedProvider: () => 'claude' as const,
    prepareFresh: async () => { refreshes++ }, pin: (_ids: string[]) => {}, close: async (id: string) => { closed.push(id) },
    interrupt: async (id: string) => { if (interruptFails) throw new Error(interruptFails); interrupts.push(id) },
    controller: { async submit(input: { transcript: string; priorRunId?: string }, context: AgentSubmissionContext) {
      const result = (outcome: AgentInteractionResult['outcome']): AgentInteractionResult => ({ interactionId: context.interactionId, agentRunId: context.runId, provider: context.provider, source: 'provider', presentation: 'transient', outcome, text: `answer ${input.transcript}`, ...(contextTokens === undefined ? {} : { contextTokens }) })
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
  return { root, journal, store, calls, interrupts, closed, get lifecycle() { return lifecycle }, waitCalls, accept,
    advance: (ms: number) => { now += ms },
    setContextTokens: (value: number | undefined) => { contextTokens = value },
    failInterrupt: (why: string | null) => { interruptFails = why },
    setReject: (value: boolean) => { reject = value }, setUncertain: (value: boolean) => { uncertain = value }, get refreshes() { return refreshes },
    restart: async () => { lifecycle.dispose(); lifecycle = new AgentConversationLifecycle(options); await lifecycle.initialize(); return lifecycle },
    cleanup: async () => { lifecycle.dispose(); await rm(root, { recursive: true, force: true }) } }
}

test('continuous work rotates at twenty while preserving draft and replay', async () => {
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
    assert.equal(h.calls[20].prior, undefined)
    assert.equal(h.calls[20].context.carryoverRunId, h.calls[19].context.runId)
    assert.equal(h.lifecycle.view().record.accepted.length, 20)
    await h.accept(20)
    assert.equal(h.lifecycle.view().record.accepted.length, 1)
    assert.equal(h.lifecycle.view().snapshot.chat.turns.at(-1)!.text.length, 40000)
    assert.equal(h.lifecycle.view().snapshot.draft.text, 'typed during send')
    h.calls[20].settle(); await queued.completion
    await h.lifecycle.submit({ transcript: 'm1 replay', submissionId: 's1' })
    assert.equal(h.calls.length, 21)
    assert.equal(h.refreshes, 2)
  } finally { await h.cleanup() }
})

test('turn ceiling rotates before the next queued message without waiting for idle', async () => {
  const h = await harness(2)
  try {
    const one = h.lifecycle.submit({ transcript: 'one', submissionId: 'one' })
    await h.waitCalls(1); await h.accept(0); h.calls[0].settle(); await one
    const two = h.lifecycle.submit({ transcript: 'two', submissionId: 'two' })
    await h.waitCalls(2); await h.accept(1)
    const queued = await h.lifecycle.enqueue({ transcript: 'what about that?', submissionId: 'three' })
    h.calls[1].settle(); await two
    await h.waitCalls(3)
    assert.equal(h.calls[2].prior, undefined)
    assert.equal(h.calls[2].context.handoff?.recentTurns.at(-1)?.text, 'answer two')
    await h.accept(2); h.calls[2].settle(); await queued.completion
    assert.equal(h.lifecycle.view().snapshot.chat.turns.length, 6)
  } finally { await h.cleanup() }
})

test('measured context rotates before the turn ceiling', async () => {
  const h = await harness(20)
  try {
    h.setContextTokens(170_000)
    const first = h.lifecycle.submit({ transcript: 'one' })
    await h.waitCalls(1); await h.accept(0); h.calls[0].settle(); await first
    assert.equal(h.lifecycle.view().record.lastContextTokens, 170_000)
    await h.restart()
    const second = h.lifecycle.submit({ transcript: 'follow up' })
    await h.waitCalls(2)
    assert.equal(h.calls[1].prior, undefined)
    assert.equal(h.calls[1].context.handoff?.recentTurns.at(-1)?.text, 'answer one')
    await h.accept(1); h.calls[1].settle(); await second
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

test('a retained message from an earlier build\'s provider switch no longer blocks sends after restart', async () => {
  const h = await harness()
  try {
    const first = h.lifecycle.submit({ transcript: 'working context', submissionId: 'first' })
    await h.waitCalls(1); await h.accept(0); h.calls[0].settle(); await first
    h.setReject(true)
    await h.lifecycle.submit({ transcript: 'retained request', submissionId: 'retained' })
    // Earlier builds cleared the error on switch but kept the failed message
    // behind retryRequired, which enqueue() refuses to send past.
    const { record, snapshot } = h.lifecycle.view()
    delete snapshot.error
    await (h.lifecycle as any).publish({ ...record, pendingProvider: 'codex' }, { ...snapshot, retryRequired: true })
    h.setReject(false)

    await h.restart()
    assert.equal(h.lifecycle.view().snapshot.retryRequired, undefined)
    assert.equal(h.lifecycle.view().snapshot.queued.length, 0)
    const next = h.lifecycle.submit({ transcript: 'new provider message', submissionId: 'after-restart' })
    await h.waitCalls(2)
    assert.equal(h.calls[1].text, 'new provider message')
    assert.equal(h.calls[1].context.provider, 'codex')
    await h.accept(1); h.calls[1].settle()
    assert.equal((await next).outcome, 'completed')
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

/** The handoff budget used to be filled from the FRONT of the chat, and the
 *  chat is never cleared across sessions — so a switch on 16 Sep carried clips
 *  from 8 Sep and nothing from the hours in between. */
test('a provider handoff summarizes the most recent older work, not the oldest', async () => {
  const h = await harness()
  try {
    const long = 'x'.repeat(400)
    for (let n = 1; n <= 30; n++) {
      const pending = h.lifecycle.submit({ transcript: `question ${n} ${long}`, submissionId: `turn-${n}` })
      await h.waitCalls(n); await h.accept(n - 1); h.calls[n - 1].settle(); await pending
    }
    await h.lifecycle.requestProvider('codex')
    const switched = h.lifecycle.submit({ transcript: 'continue', submissionId: 'switched' })
    await h.waitCalls(31)
    const { summary } = h.calls[30].context.handoff!
    assert.match(summary, /question 24 /, 'the exchange just before the verbatim six is kept')
    assert.doesNotMatch(summary, /question 1 /, 'the oldest is what gives way')
    assert.match(summary, /30 completed exchanges/)
    await h.accept(30); h.calls[30].settle(); await switched
  } finally { await h.cleanup() }
})

test('turn ceiling rotates despite draft or recent activity; idle alone does not rotate', async () => {
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
    assert.equal(h.calls[2].prior, undefined)
    assert.equal(h.lifecycle.view().snapshot.draft.text, 'composing')
    await h.lifecycle.setDraft('', 2)
    h.advance(20 * 60_000 - 1)
    await turn('four', 4)
    assert.equal(h.calls[3].prior, h.calls[2].context.runId)
    h.advance(20 * 60_000)
    await turn('five', 5)
    assert.equal(h.calls[4].prior, undefined)
    assert.equal(h.calls[4].context.carryoverRunId, h.calls[2].context.runId)
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

test('a recovery-required conversation can be explicitly replaced without replaying retained input', async () => {
  const h = await harness()
  try {
    h.setUncertain(true)
    await h.lifecycle.submit({ transcript: 'possibly sent', submissionId: 'uncertain' })
    assert.equal(h.lifecycle.view().record.phase, 'recovery-required')
    assert.equal(h.lifecycle.view().snapshot.queued.length, 1)
    assert.deepEqual(await h.lifecycle.discard(), { discarded: true })
    assert.equal(h.closed.length, 1, 'the uncertain provider run is closed')
    assert.equal(h.lifecycle.view().record.phase, 'ready')
    assert.equal(h.lifecycle.view().snapshot.queued.length, 0)
    h.setUncertain(false)
    const next = h.lifecycle.submit({ transcript: 'new request', submissionId: 'new' })
    await h.waitCalls(1)
    await h.accept(0); h.calls[0].settle(); await next
    assert.equal(h.calls[0].text, 'new request')
  } finally { await h.cleanup() }
})

test('restart at threshold rotates on the next message and carries prior run context', async () => {
  const h = await harness(1)
  try {
    const pending = h.lifecycle.submit({ transcript: 'boundary', submissionId: 'boundary' })
    await h.waitCalls(1); await h.accept(0)
    await h.restart()
    assert.equal(h.lifecycle.view().record.phase, 'reset-due')
    assert.equal(h.lifecycle.view().record.accepted[0].outcome, 'interrupted')
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

test('a fresh conversation and a discard both stamp chat.startedAt, and it survives a restart', async () => {
  const h = await harness()
  try {
    assert.equal(h.lifecycle.view().snapshot.chat.startedAt, 1_000, 'a brand-new record starts now')
    h.advance(5_000)
    await h.lifecycle.discard()
    assert.equal(h.lifecycle.view().snapshot.chat.startedAt, 6_000, 'discard starts a new conversation now')
    const revived = await h.restart()
    assert.equal(revived.view().snapshot.chat.startedAt, 6_000, 'the stored marker is kept, not re-stamped on restore')
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

/**
 * STOPPING A TURN — FIELD REPORT (2026-09-20).
 *
 * Every other chat in the app draws a Stop at the send position while it is
 * working. The Agent's chat did not, and the reason was here: nothing in the
 * app connected a surface to `supervisor.interrupt`. The SIGINT path itself has
 * always existed and always worked — `remote:agent-cancel` reaches it — but it
 * had no caller, so a turn that went long could only be waited out.
 *
 * The lifecycle is the only thing that knows WHICH run is live, which is why
 * the signal is sent from here rather than from the surface.
 */
test('stop interrupts the live run, and only while one is actually running', async () => {
  const h = await harness()
  try {
    assert.deepEqual(await h.lifecycle.interrupt(), { interrupted: false, reason: 'nothing is running' },
      'idle: there is no run to signal, and saying so is not an error')

    const p = h.lifecycle.submit({ transcript: 'read every file in the repo', submissionId: 's1' })
    await h.waitCalls(1)
    await h.accept(0)
    assert.deepEqual(await h.lifecycle.interrupt(), { interrupted: true })
    assert.deepEqual(h.interrupts, [h.calls[0].context.runId], 'the LIVE run, named by the record')

    // The provider answers the signal for itself; the lifecycle only settles
    // what comes back — which is the ordinary accepted-then-failed path.
    h.calls[0].settle('interrupted')
    assert.equal((await p).outcome, 'interrupted')
    const view = h.lifecycle.view()
    const last = view.snapshot.chat.turns.at(-1)!
    // RED IS FOR WHAT THEY DID NOT ASK FOR. `failed` would paint the turn red,
    // latch the card to `failed`, and put the provider's parting error in the
    // transcript as though it were the answer.
    assert.equal(last.failed, undefined, 'a stopped turn is not a failed turn')
    assert.equal(last.text, 'Stopped.', 'it says so, plainly, and stays out of the way')
    assert.equal(view.snapshot.queued.length, 0, 'stopping is not a retry — nothing is re-sent')
    assert.equal(view.record.phase, 'ready', 'and the chat is ready for the next message')

    assert.deepEqual(await h.lifecycle.interrupt(), { interrupted: false, reason: 'nothing is running' },
      'settled: the turn is over, so there is nothing left to stop')
  } finally { await h.cleanup() }
})

test('a refused interrupt is reported rather than thrown at the surface', async () => {
  const h = await harness()
  try {
    const p = h.lifecycle.submit({ transcript: 'go', submissionId: 's1' })
    await h.waitCalls(1); await h.accept(0)
    h.failInterrupt('run-busy')
    assert.deepEqual(await h.lifecycle.interrupt(), { interrupted: false, reason: 'run-busy' })
    h.failInterrupt(null)
    h.calls[0].settle(); await p
  } finally { await h.cleanup() }
})

/**
 * STOP DURING THE STARTUP WINDOW. A turn is busy — and draws a Stop — from the
 * moment it is prepared, but the run it would be signalled on does not exist
 * until the CLI is spawned and accepted, which takes seconds. Refusing there
 * would make the button do nothing for exactly as long as the wait that makes
 * people press it.
 */
test('a stop that arrives before the run exists is held and delivered on acceptance', async () => {
  const h = await harness()
  try {
    const p = h.lifecycle.submit({ transcript: 'go', submissionId: 's1' })
    await h.waitCalls(1)
    assert.deepEqual(await h.lifecycle.interrupt(), { interrupted: true }, 'prepared: held, not refused')
    assert.deepEqual(h.interrupts, [], 'there is nothing to signal yet')

    await h.accept(0)
    assert.deepEqual(h.interrupts, [h.calls[0].context.runId], 'delivered the moment the run exists')

    h.calls[0].settle('interrupted'); await p
    // And it is spent: the next turn starts clean rather than inheriting it.
    const second = h.lifecycle.submit({ transcript: 'again', submissionId: 's2' })
    await h.waitCalls(2); await h.accept(1)
    assert.deepEqual(h.interrupts, [h.calls[0].context.runId], 'a held stop belongs to one turn only')
    h.calls[1].settle(); await second
  } finally { await h.cleanup() }
})

test('a held stop whose turn never started does not fire at the next one', async () => {
  const h = await harness()
  try {
    h.setReject(true)
    const failed = h.lifecycle.enqueue({ transcript: 'go', submissionId: 's1' })
    await failed
    assert.deepEqual(await h.lifecycle.interrupt(), { interrupted: false, reason: 'nothing is running' },
      'the turn failed to start, so nothing is prepared and nothing is held')
    h.setReject(false)
    const retry = h.lifecycle.retry()
    await h.waitCalls(1); await h.accept(0)
    assert.deepEqual(h.interrupts, [], 'the retry runs untouched')
    h.calls[0].settle(); await retry
  } finally { await h.cleanup() }
})
