import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentConversationLifecycle } from './lifecycle'
import { AgentJournal } from './journal'
import { AgentConversationStore } from './conversation-store'
import { MemoryCrypto } from './memory/crypto'
import type { AgentInteractionResult, AgentSubmissionContext } from './controller'
import type { AgentProviderId } from './provider'

/** Claude cannot answer; Codex can. `accepted` decides whether Claude took the
 *  message before failing (it is then a failed turn in the chat). */
async function harness(opts: { accepted: boolean; code: 'model-unavailable' | 'provider-unavailable' | 'provider-crashed'; alternate?: AgentProviderId }) {
  const root = await mkdtemp(join(tmpdir(), 'agent-switch-'))
  const calls: AgentProviderId[] = []
  const lifecycle = new AgentConversationLifecycle({
    journal: new AgentJournal({ root }),
    store: new AgentConversationStore({ root: join(root, 'c'), crypto: new MemoryCrypto({ keyProvider: { getMasterKey: async () => Buffer.alloc(32, 5) } }) }),
    selectedProvider: () => 'claude', prepareFresh: async () => {}, pin: () => {}, close: async () => {},
    alternateProvider: current => opts.alternate && opts.alternate !== current ? opts.alternate : undefined,
    controller: { async submit(input: { transcript: string }, context: AgentSubmissionContext): Promise<AgentInteractionResult> {
      calls.push(context.provider!)
      const base = { interactionId: context.interactionId, agentRunId: context.runId, provider: context.provider, source: 'provider' as const, presentation: 'transient' as const }
      const accept = () => context.onAccepted?.({ id: context.runId, provider: context.provider!, providerHandle: `h-${context.runId}`, model: 'm', state: 'running', createdAt: 1, lastUserAt: 1, lastActivityAt: 1, providerWorkEnded: false } as any)
      if (context.provider === 'claude') {
        if (opts.accepted) await accept()
        return { ...base, outcome: 'failed', error: { code: opts.code, message: 'No working model right now (usage limit reached).' } }
      }
      await accept()
      return { ...base, outcome: 'completed', text: `codex: ${input.transcript}` }
    } },
  })
  await lifecycle.initialize()
  return { lifecycle, calls, cleanup: async () => { lifecycle.dispose(); await rm(root, { recursive: true, force: true }) } }
}

async function settle(lifecycle: AgentConversationLifecycle) {
  for (let i = 0; i < 200; i++) {
    const v = lifecycle.view()
    if (!v.snapshot.queued.length && v.record.phase !== 'sending' && !v.record.prepared && !v.snapshot.settlementPending) return v
    await new Promise(r => setTimeout(r, 5))
  }
  return lifecycle.view()
}

test('failed after acceptance: the message is re-sent to the other provider and the answer says why', async () => {
  const h = await harness({ accepted: true, code: 'model-unavailable', alternate: 'codex' })
  try {
    const failed = await h.lifecycle.submit({ transcript: 'hello', submissionId: 's1' })
    assert.equal(failed.outcome, 'failed', 'the original turn reports its own failure')
    // The re-send is queued right after that failure is recorded.
    for (let i = 0; h.calls.length < 2 && i < 200; i++) await new Promise(r => setTimeout(r, 5))
    const view = await settle(h.lifecycle)
    assert.deepEqual(h.calls, ['claude', 'codex'])
    const answer = view.snapshot.chat.turns.at(-1)!
    assert.equal(answer.text, 'codex: hello')
    assert.match(answer.notice ?? '', /Claude could not answer \(usage limit reached\), so Codex answered/)
    assert.equal(view.record.provider, 'codex')
    assert.equal(view.snapshot.error, undefined, 'the chat is not blocked')
  } finally { await h.cleanup() }
})

test('refused before acceptance: the queued message simply goes to the other provider', async () => {
  const h = await harness({ accepted: false, code: 'provider-unavailable', alternate: 'codex' })
  try {
    const result = await h.lifecycle.submit({ transcript: 'hi', submissionId: 's1' })
    assert.equal(result.outcome, 'completed')
    assert.deepEqual(h.calls, ['claude', 'codex'])
    const view = await settle(h.lifecycle)
    assert.match(view.snapshot.chat.turns.at(-1)!.notice ?? '', /Claude is unavailable, so Codex answered/)
  } finally { await h.cleanup() }
})

test('switching off, or a failure no provider would fix, keeps the old behaviour', async () => {
  for (const opts of [{ accepted: true, code: 'model-unavailable' as const }, { accepted: true, code: 'provider-crashed' as const, alternate: 'codex' as const }]) {
    const h = await harness(opts)
    try {
      await h.lifecycle.submit({ transcript: 'x', submissionId: 's1' })
      await settle(h.lifecycle)
      assert.deepEqual(h.calls, ['claude'])
    } finally { await h.cleanup() }
  }
})
