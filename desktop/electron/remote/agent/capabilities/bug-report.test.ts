import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BugReportCapability } from './bug-report.ts'
import { CapabilityRegistry } from './registry.ts'
import type { CapabilityCallContext, McpPrincipal } from '../types.ts'

const principal: McpPrincipal = { kind: 'unmute-agent', runId: 'run', interactionId: 'turn', expiresAt: 200 }
const context = (transcript: string, intents: string[] = ['report-bug']): CapabilityCallContext => ({
  principal, now: 100, interaction: { id: 'turn', active: true, intents, transcript, attachmentHandles: ['host-handle'] },
})

test('sends the host transcript and capture handles after an explicit request', async () => {
  let submitted: unknown
  const registry = new CapabilityRegistry([new BugReportCapability(async report => {
    submitted = report
    return { id: 'report-1', screenshotCount: 2 }
  })], () => {})
  const reply = await registry.call(principal, 'unmute_report_bug', { summary: 'Mic stops after sleep' }, {
    interaction: context('Please report this bug to Unmute. The mic stops after sleep.').interaction,
    now: 100,
  })
  assert.equal(reply.isError, undefined)
  assert.deepEqual(submitted, {
    principal, transcript: 'Please report this bug to Unmute. The mic stops after sleep.',
    summary: 'Mic stops after sleep', attachmentHandles: ['host-handle'],
  })
})

test('does not submit on discussion, old intent, or a task principal', async () => {
  let calls = 0
  const capability = new BugReportCapability(async () => { calls++; return { id: 'unused', screenshotCount: 1 } })
  const registry = new CapabilityRegistry([capability], () => {})
  for (const transcript of ['I found a bug in Unmute.', 'How do I report a bug to Unmute?']) {
    const reply = await registry.call(principal, 'unmute_report_bug', { summary: 'Mic broken' }, { interaction: context(transcript).interaction, now: 100 })
    assert.equal(reply.isError, true)
  }
  await assert.rejects(() => registry.call(principal, 'unmute_report_bug', { summary: 'Mic broken' }, { interaction: context('Report this bug to Unmute.', []).interaction, now: 100 }))
  await assert.rejects(() => registry.call({ kind: 'task', taskId: 'task' }, 'unmute_report_bug', { summary: 'Mic broken' }, { now: 100 }))
  assert.equal(calls, 0)
})

test('repeat calls in one interaction return the original receipt', async () => {
  let calls = 0
  const registry = new CapabilityRegistry([new BugReportCapability(async () => {
    calls++
    return { id: 'report-1', screenshotCount: 1 }
  })], () => {})
  const interaction = context('Report this bug to Unmute.').interaction
  const first = await registry.call(principal, 'unmute_report_bug', { summary: 'Mic broken' }, { interaction, now: 100 })
  const second = await registry.call(principal, 'unmute_report_bug', { summary: 'Different wording' }, { interaction, now: 100 })
  assert.equal(calls, 1)
  assert.deepEqual(second, first)
})
