import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HelpCapability } from './help.ts'
import type { CapabilityCallContext, McpPrincipal, ToolResult } from '../types.ts'

const NOW = 10_000
const agent: McpPrincipal = { kind: 'unmute-agent', runId: 'run-1', interactionId: 'ix-1', expiresAt: 20_000 }
const ctx: CapabilityCallContext = { principal: agent, now: NOW, interaction: { id: 'ix-1', active: true } }
function parse(result: ToolResult): any { return JSON.parse(String(result.content[0]!.text)) }

test('answers product questions with the current configured keys', async () => {
  const capability = new HelpCapability(() => ({ dictationKey: 'right-option', activationMode: 'push-to-talk' }))
  const answer = parse(await capability.call(ctx, 'unmute_help', { query: 'How do I dictate?' }))
  assert.equal(answer.ok, true)
  assert.match(JSON.stringify(answer.result), /Hold Right Option while you talk/)
  assert.doesNotMatch(JSON.stringify(answer.result), /depending on Settings/)
})

test('explains the session manager and Notetaker from the same catalog', async () => {
  const capability = new HelpCapability(() => ({ dictationKey: 'fn', activationMode: 'tap-toggle' }))
  const manager = parse(await capability.call(ctx, 'unmute_help', { query: 'What is the Unmute Agent for?' }))
  assert.match(JSON.stringify(manager.result), /session manager/i)
  const notes = parse(await capability.call(ctx, 'unmute_help', { query: 'How do I start meeting notes?' }))
  assert.match(JSON.stringify(notes.result), /Double-tap Left Control/)
})

test('an index request returns short sections and a no-match query falls back safely', async () => {
  const capability = new HelpCapability(() => ({ dictationKey: 'fn', activationMode: 'double-tap-push' }))
  const index = parse(await capability.call(ctx, 'unmute_help', {}))
  assert.deepEqual(index.result.sections.map((section: any) => section.id), ['dictation', 'sessions', 'notetaker', 'notch'])
  const missed = parse(await capability.call(ctx, 'unmute_help', { query: 'quantum banana' }))
  assert.equal(missed.result.matches.length, 0)
  assert.match(missed.result.message, /open How to use Unmute/i)
})

test('ordinary task principals cannot read Agent product help', async () => {
  const taskCtx: CapabilityCallContext = { principal: { kind: 'task', taskId: 'task-1' }, now: NOW }
  const result = await new HelpCapability(() => ({ dictationKey: 'fn', activationMode: 'tap-toggle' })).call(taskCtx, 'unmute_help', {})
  assert.equal(result.isError, true)
})
