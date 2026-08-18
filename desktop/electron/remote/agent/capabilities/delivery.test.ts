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

function transaction(options: {
  write?: (chunk: Uint8Array) => Promise<void>
  commit?: () => Promise<void>
  rollback?: () => Promise<void>
} = {}) {
  return {
    write: options.write ?? (async () => {}),
    commit: options.commit ?? (async () => {}),
    rollback: options.rollback ?? (async () => {}),
  }
}

test('exposes exactly copy text, open attachment file, copy attachment, and attach to task draft to Agent principals', () => {
  const capability = new DeliveryCapability({
    async resolveAttachment() { return attachment() },
    async copyText() {},
    async stageAttachmentCopy() { return transaction() },
    async stageTaskDraftAttachment() { return transaction() },
  })
  const registry = new CapabilityRegistry([capability])

  assert.deepEqual(registry.tools(agent).map(({ name }) => name), [
    'delivery_copy_text',
    // Opening and copying are different requests: "give me my resume" wants
    // text on the clipboard, "open my resume" wants the document in front of
    // the user.
    'delivery_open_attachment_file',
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
    async stageAttachmentCopy() { return transaction() },
    async stageTaskDraftAttachment() { return transaction() },
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
    async stageAttachmentCopy(value) {
      const staged: Buffer[] = []
      return transaction({
        async write(chunk) { staged.push(Buffer.from(chunk)) },
        async commit() { copied.push(Buffer.concat(staged)) },
        async rollback() { staged.length = 0 },
      })
    },
    async stageTaskDraftAttachment() { return transaction() },
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
    async stageAttachmentCopy() { return transaction() },
    async stageTaskDraftAttachment(taskId, value) {
      return transaction({ async commit() { attached.push({ taskId, name: value.name }) } })
    },
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
    async stageAttachmentCopy() { called = true; return transaction() },
    async stageTaskDraftAttachment() { called = true; return transaction() },
  })

  await assert.rejects(
    capability.call({ principal: agent, now: NOW }, 'delivery_copy_attachment', { handle: 'open-opaque' }),
    /active explicit interaction/i,
  )
  assert.equal(called, false)
})

for (const failure of ['substituted ciphertext', 'truncated final frame'] as const) {
  test(`${failure} rolls back staged attachment bytes without committing an external side effect`, async () => {
    const external: Buffer[] = []
    const staged: Buffer[] = []
    let commits = 0
    let rollbacks = 0
    const corrupt: DeliveryAttachment = {
      name: 'resume.pdf', mimeType: 'application/pdf', size: 12,
      async *open() {
        yield Buffer.from('untrusted partial bytes')
        throw new Error('Encrypted attachment payload is invalid')
      },
    }
    const registry = new CapabilityRegistry([new DeliveryCapability({
      async resolveAttachment() { return corrupt },
      async copyText() {},
      async stageAttachmentCopy() {
        return transaction({
          async write(chunk) { staged.push(Buffer.from(chunk)) },
          async commit() { commits += 1; external.push(Buffer.concat(staged)) },
          async rollback() { rollbacks += 1; staged.length = 0 },
        })
      },
      async stageTaskDraftAttachment() { return transaction() },
    })])

    await assert.rejects(
      registry.call(agent, 'delivery_copy_attachment', { handle: 'open-opaque' }, { now: NOW, interaction }),
      /encrypted attachment payload is invalid/i,
    )
    assert.deepEqual(external, [])
    assert.equal(commits, 0)
    assert.equal(rollbacks, 1)
    assert.deepEqual(staged, [])
  })
}

test('a late destination staging failure explicitly rolls back and never commits', async () => {
  let commits = 0
  let rollbacks = 0
  let writes = 0
  const registry = new CapabilityRegistry([new DeliveryCapability({
    async resolveAttachment() {
      return {
        name: 'resume.pdf', mimeType: 'application/pdf', size: 6,
        async *open() { yield Buffer.from('one'); yield Buffer.from('two') },
      }
    },
    async copyText() {},
    async stageAttachmentCopy() {
      return transaction({
        async write() { writes += 1; if (writes === 2) throw new Error('destination staging failed') },
        async commit() { commits += 1 },
        async rollback() { rollbacks += 1 },
      })
    },
    async stageTaskDraftAttachment() { return transaction() },
  })])

  await assert.rejects(
    registry.call(agent, 'delivery_copy_attachment', { handle: 'open-opaque' }, { now: NOW, interaction }),
    /destination staging failed/i,
  )
  assert.equal(commits, 0)
  assert.equal(rollbacks, 1)
})
