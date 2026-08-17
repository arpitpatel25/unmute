import assert from 'node:assert/strict'
import test from 'node:test'

import { CapabilityRegistry } from './registry.ts'
import { DeliveryCapability, type DeliveryAttachment } from './delivery.ts'
import type { McpPrincipal } from '../types.ts'

const NOW = 2_000
const agent: McpPrincipal = {
  kind: 'unmute-agent', runId: 'run-1', interactionId: 'ix-1', expiresAt: 3_000,
}
const task: McpPrincipal = { kind: 'task', taskId: 'task-1' }
const interaction = { id: 'ix-1', active: true }

function attachment(): DeliveryAttachment {
  return {
    name: 'resume.pdf', mimeType: 'application/pdf', size: 6,
    async *open() { yield Buffer.from('resume') },
  }
}

test('exposes exactly copy text, copy attachment, and attach to task draft to Agent principals', () => {
  const capability = new DeliveryCapability({
    async resolveAttachment() { return attachment() },
    async copyText() {},
    async copyAttachment() {},
    async attachToTaskDraft() {},
  })
  const registry = new CapabilityRegistry([capability])

  assert.deepEqual(registry.tools(agent).map(({ name }) => name), [
    'delivery_copy_text',
    'delivery_copy_attachment',
    'delivery_attach_to_task_draft',
  ])
  assert.deepEqual(registry.tools(task), [])
})

test('copy text requires the active Agent interaction and delivers only validated text', async () => {
  const copied: string[] = []
  const registry = new CapabilityRegistry([new DeliveryCapability({
    async resolveAttachment() { return attachment() },
    async copyText(text) { copied.push(text) },
    async copyAttachment() {},
    async attachToTaskDraft() {},
  })])

  await assert.rejects(registry.call(agent, 'delivery_copy_text', { text: 'hello' }, { now: NOW }), /active explicit interaction/i)
  await assert.rejects(
    registry.call(agent, 'delivery_copy_text', { text: '', destination: 'clipboard' }, { now: NOW, interaction }),
    /input/i,
  )
  const result = await registry.call(
    agent, 'delivery_copy_text', { text: 'hello' }, { now: NOW, interaction },
  )

  assert.deepEqual(copied, ['hello'])
  assert.deepEqual(result, { content: [{ type: 'text', text: 'Text copied' }] })
})

test('copy attachment resolves only an opaque open handle and never accepts a path fallback', async () => {
  const copied: Buffer[] = []
  const resolved: string[] = []
  const registry = new CapabilityRegistry([new DeliveryCapability({
    async resolveAttachment(principal, handle) {
      assert.deepEqual(principal, agent)
      resolved.push(handle)
      return attachment()
    },
    async copyText() {},
    async copyAttachment(value) {
      const chunks: Buffer[] = []
      for await (const chunk of value.open()) chunks.push(Buffer.from(chunk))
      copied.push(Buffer.concat(chunks))
    },
    async attachToTaskDraft() {},
  })])

  await assert.rejects(
    registry.call(agent, 'delivery_copy_attachment', { path: '/private/resume.pdf' }, { now: NOW, interaction }),
    /input/i,
  )
  const result = await registry.call(
    agent, 'delivery_copy_attachment', { handle: 'open-opaque' }, { now: NOW, interaction },
  )

  assert.deepEqual(resolved, ['open-opaque'])
  assert.deepEqual(copied, [Buffer.from('resume')])
  assert.equal(JSON.stringify(result).includes('/private'), false)
  assert.deepEqual(result, { content: [{ type: 'text', text: 'Attachment copied' }] })
})

test('attach to task draft validates its own task destination and reports success only after the adapter resolves', async () => {
  const attached: Array<{ taskId: string; name: string }> = []
  const registry = new CapabilityRegistry([new DeliveryCapability({
    async resolveAttachment(_principal, handle) {
      if (handle !== 'open-opaque') throw new Error('invalid handle')
      return attachment()
    },
    async copyText() {},
    async copyAttachment() {},
    async attachToTaskDraft(taskId, value) { attached.push({ taskId, name: value.name }) },
  })])

  await assert.rejects(
    registry.call(agent, 'delivery_attach_to_task_draft', {
      handle: 'open-opaque', taskId: '../task', destination: 'anything',
    }, { now: NOW, interaction }),
    /input/i,
  )
  const result = await registry.call(agent, 'delivery_attach_to_task_draft', {
    handle: 'open-opaque', taskId: 'task-123',
  }, { now: NOW, interaction })

  assert.deepEqual(attached, [{ taskId: 'task-123', name: 'resume.pdf' }])
  assert.deepEqual(result, { content: [{ type: 'text', text: 'Attachment added to task draft' }] })
})

test('direct module calls also fail closed without a live matching Agent interaction', async () => {
  let called = false
  const capability = new DeliveryCapability({
    async resolveAttachment() { called = true; return attachment() },
    async copyText() { called = true },
    async copyAttachment() { called = true },
    async attachToTaskDraft() { called = true },
  })

  await assert.rejects(
    capability.call({ principal: agent, now: NOW }, 'delivery_copy_attachment', { handle: 'open-opaque' }),
    /active explicit interaction/i,
  )
  assert.equal(called, false)
})
