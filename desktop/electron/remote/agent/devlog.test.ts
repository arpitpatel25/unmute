import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { configureRemoteLogging, setConsoleMirror } from '../log'
import {
  classifyRetrieval, describeToolInput, devInteractionEnded, devInteractionStarted, devProviderTool, devToolCall,
} from './devlog'
import { CapabilityRegistry } from './capabilities/registry'
import type { CapabilityModule } from './types'

setConsoleMirror(false)
const dir = mkdtempSync(join(tmpdir(), 'agent-devlog-'))
const file = configureRemoteLogging({ dir, runId: 'test', synchronous: true })

function events(name: string): Array<Record<string, any>> {
  return readFileSync(file, 'utf8').split('\n')
    .filter(line => line.includes(`[remote:agent-decision]`) && line.includes(` ${name} `))
    .map(line => JSON.parse(line.slice(line.indexOf('{'))))
}

function withGate<T>(on: boolean, run: () => T): T {
  const before = process.env.UNMUTE_CURATOR_DEVLOG
  if (on) process.env.UNMUTE_CURATOR_DEVLOG = '1'; else delete process.env.UNMUTE_CURATOR_DEVLOG
  try { return run() } finally {
    if (before === undefined) delete process.env.UNMUTE_CURATOR_DEVLOG; else process.env.UNMUTE_CURATOR_DEVLOG = before
  }
}

/** The command the Agent actually ran on 2026-09-18, as Codex recorded it. */
const TANMAY_GREP = JSON.stringify({ code: 'tools.exec_command({ cmd: "rg -i -n -m 50 \'Tanmay|WhatsApp\' \\"$HOME/.unmute/remote/session-index/turns.jsonl\\"", max_output_tokens: 12000 })' })

test('the 2026-09-18 grep is recognised as a capped grep of the index', () => {
  const shape = classifyRetrieval('exec', TANMAY_GREP)
  assert.equal(shape.path, 'index-grep')
  assert.deepEqual(shape.caps, ['-m 50', 'max_output_tokens 12000'])
})

test('index_search, a transcript read and an unrelated command are told apart', () => {
  assert.deepEqual(classifyRetrieval('index_search', '{"terms":["Tanmay"],"limit":15}'), { path: 'index-search-tool', caps: [] })
  assert.equal(classifyRetrieval('Read', '{"file_path":"/Users/x/.claude/projects/p/abc.jsonl","offset":10}').path, 'transcript-read')
  assert.equal(classifyRetrieval('Grep', '{"pattern":"onboarding","path":"/Users/x/.unmute/remote/session-index/turns.jsonl"}').path, 'index-grep')
  assert.deepEqual(classifyRetrieval('exec_command', '["ls","-la"]'), { path: 'other', caps: [] })
  assert.deepEqual(classifyRetrieval('exec_command', 'rg -i onboarding ~/.unmute/remote/session-index/turns.jsonl | tail -n 120').caps, ['| tail 120'])
})

test('with the gate off nothing is logged and nothing is kept', () => {
  withGate(false, () => {
    devInteractionStarted('ix-off', { runId: 'r', provider: 'codex', transcript: 'hello', resumed: false })
    devProviderTool('ix-off', 'exec', TANMAY_GREP)
    devToolCall('ix-off', { at: 1, tool: 'task_create', outcome: 'success' })
    devInteractionEnded('ix-off', { outcome: 'completed' })
  })
  assert.equal(events('interaction.summary').filter(e => e.interactionId === 'ix-off').length, 0)
  assert.equal(events('provider-tool').filter(e => e.interactionId === 'ix-off').length, 0)
})

test('the summary says the Agent grepped a capped slice and then acted without index_search', () => {
  withGate(true, () => {
    devInteractionStarted('ix-1', { runId: 'r', provider: 'codex', transcript: 'message Tanmay that we are missing him', resumed: false })
    devToolCall('ix-1', { at: 1, tool: 'sessions_open', outcome: 'success' })
    devToolCall('ix-1', { at: 2, tool: 'memory_list', outcome: 'success' })
    devProviderTool('ix-1', 'exec', TANMAY_GREP)
    devToolCall('ix-1', { at: 3, tool: 'task_create', outcome: 'success', facts: { contextChars: 0, sourceSessions: 0 } })
    devInteractionEnded('ix-1', { outcome: 'completed', finalText: 'Made Message Tanmay on WhatsApp.' })
  })
  const [summary] = events('interaction.summary').filter(e => e.interactionId === 'ix-1')
  assert.ok(summary)
  assert.deepEqual(summary.readsBeforeFirstAction, { sessionsOpen: true, index: true, memoryList: true })
  assert.equal(summary.firstAction, 'task_create')
  assert.equal(summary.indexSearchCalls, 0)
  assert.equal(summary.indexGreps, 1)
  assert.deepEqual(summary.cappedIndexGreps, [['-m 50', 'max_output_tokens 12000']])
  assert.deepEqual(summary.handoffs, [{ tool: 'task_create', contextChars: 0, sourceSessions: 0 }])
  assert.equal(events('retrieval.capped-grep').filter(e => e.interactionId === 'ix-1').length, 1)
  assert.equal(events('decision.grep-instead-of-index-search').filter(e => e.interactionId === 'ix-1').length, 1)
})

test('acting with no look at the index at all is called out', () => {
  withGate(true, () => {
    devInteractionStarted('ix-2', { runId: 'r', provider: 'claude', transcript: 'send it', resumed: false })
    devToolCall('ix-2', { at: 1, tool: 'task_create', outcome: 'success' })
    devInteractionEnded('ix-2', { outcome: 'completed' })
  })
  assert.equal(events('decision.acted-without-index').filter(e => e.interactionId === 'ix-2').length, 1)
})

test('a task handoff is described by what it carried, not its contents', () => {
  const described = describeToolInput('mcp__unmute__task_create', {
    title: 'Message Tanmay', group: 'WhatsApp messages', kind: 'oneoff', intent: 'Message Tanmay',
    context: 'x'.repeat(420), sourceSessions: [{ sessionId: 'a', provider: 'codex' }], artifacts: [],
  })
  assert.deepEqual(described, {
    title: 'Message Tanmay', group: 'WhatsApp messages', kind: 'oneoff', intent: 'Message Tanmay',
    contextChars: 420, sourceSessions: 1, artifacts: 0,
  })
})

test('calls through the real registry reach the interaction summary with their results', async () => {
  const fake: CapabilityModule = {
    id: 'fake', roles: ['unmute-agent'],
    tools: [
      { name: 'index_search', description: '', inputSchema: {}, consequence: 'read' },
      { name: 'task_create', description: '', inputSchema: {}, consequence: 'reversible-write' },
    ],
    async call(_ctx, tool) {
      const result = tool === 'index_search'
        ? { matchedSessions: 48, matchedTurns: 63, remaining: 33, nextCursor: 15, sessions: [{ sessionId: 's1', match: 'exact' }] }
        : { taskId: 'task-1', status: 'created' }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, result }) }] }
    },
  }
  const registry = new CapabilityRegistry([fake], () => {})
  const principal = { kind: 'unmute-agent' as const, runId: 'r', interactionId: 'ix-3', expiresAt: Date.now() + 60_000 }
  const before = process.env.UNMUTE_CURATOR_DEVLOG
  process.env.UNMUTE_CURATOR_DEVLOG = '1'
  try {
    devInteractionStarted('ix-3', { runId: 'r', provider: 'codex', transcript: 'message Tanmay', resumed: false })
    await registry.call(principal, 'index_search', { terms: ['Tanmay', 'IITGN'] }, { interaction: { id: 'ix-3', active: true } })
    await registry.call(principal, 'task_create', { title: 'Message Tanmay', group: 'WhatsApp messages', intent: 'Message Tanmay', context: 'He is Tanmay IITGN', sourceSessions: [{ sessionId: 's1', provider: 'codex' }] }, { interaction: { id: 'ix-3', active: true } })
    devInteractionEnded('ix-3', { outcome: 'completed' })
  } finally {
    if (before === undefined) delete process.env.UNMUTE_CURATOR_DEVLOG; else process.env.UNMUTE_CURATOR_DEVLOG = before
  }
  const [summary] = events('interaction.summary').filter(e => e.interactionId === 'ix-3')
  assert.deepEqual(summary!.mcpTools, ['index_search:success', 'task_create:success'])
  assert.equal(summary!.indexSearchCalls, 1)
  assert.equal(summary!.indexSearchResults[0].matchedSessions, 48)
  assert.equal(summary!.indexSearchResults[0].remaining, 33)
  assert.equal(summary!.readsBeforeFirstAction.index, true)
  assert.equal(summary!.handoffs[0].contextChars, 18)
  assert.equal(summary!.handoffs[0].sourceSessions, 1)
  assert.equal(summary!.handoffs[0].taskId, 'task-1')
})
