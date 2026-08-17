import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { McpPrincipal } from '../types.ts'
import { MemoryCrypto } from './crypto.ts'
import {
  EncryptedAttachmentStore,
  InteractionAttachmentHandles,
  type DeliveryAttachment,
} from './attachments.ts'

const MASTER_KEY = Buffer.alloc(32, 0x61)
const NOW = 1_723_456_789_000
const agent = (interactionId = 'ix-1', expiresAt = NOW + 10_000): McpPrincipal => ({
  kind: 'unmute-agent', runId: 'run-1', interactionId, expiresAt,
})

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'unmute-attachment-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function memoryCrypto(): MemoryCrypto {
  return new MemoryCrypto({
    keyProvider: { async getMasterKey() { return Buffer.from(MASTER_KEY) } },
  })
}

async function contents(attachment: DeliveryAttachment): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of attachment.open()) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

test('managed copy streams encrypted content into its SHA-256 address with MIME and size metadata', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'quarterly report.txt')
  const plaintext = Buffer.from('revenue: private\n'.repeat(16_384))
  await writeFile(source, plaintext)
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: (() => {
    const values = ['capture-opaque', 'delivery-opaque']
    return () => values.shift() ?? 'unused'
  })() })
  const store = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, createAttachmentId: () => 'attachment-opaque',
  })

  const handle = handles.mintCapture(agent(), { path: source })
  const saved = await store.store(agent(), { recordId: 'record-1', handle, storage: 'copy' })

  assert.deepEqual(saved, {
    id: 'attachment-opaque',
    sha256: '7883f15d9fa160180689da4a7d4bd1d8e6d141ebb17e7c423fe3599ccf6f9f64',
    name: 'quarterly report.txt',
    mimeType: 'text/plain',
    size: plaintext.byteLength,
    storage: 'managed-copy',
    liveReferenceCount: 1,
    trashReferenceCount: 0,
  })
  const original = await readFile(join(root, 'attachments', saved.sha256!, 'original.enc'))
  assert.equal(original.includes(plaintext.subarray(0, 64)), false)
  assert.equal((await readFile(join(root, 'attachments', saved.sha256!, 'metadata.json'))).includes(Buffer.from(source)), false)
  const deliveryHandle = await store.open(agent(), saved.id)
  assert.equal(deliveryHandle.handle, 'delivery-opaque')
  assert.equal('path' in deliveryHandle, false)
  assert.deepEqual(await contents(await store.resolveForDelivery(agent(), deliveryHandle.handle)), plaintext)
})

test('managed copy rejects a payload truncated exactly between authenticated frames', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'multi-frame.bin')
  await writeFile(source, Buffer.alloc(96 * 1024, 0x52))
  let nextHandle = 0
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => `frame-${++nextHandle}` })
  const store = new EncryptedAttachmentStore({ root, crypto: memoryCrypto(), handles })
  const saved = await store.store(agent(), {
    recordId: 'record-1', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  })
  const payloadPath = join(root, 'attachments', saved.sha256, 'original.enc')
  const encrypted = await readFile(payloadPath)
  const firstFrameBytes = encrypted.readUInt32BE(5)
  await truncate(payloadPath, 5 + 4 + firstFrameBytes)
  const opened = await store.open(agent(), saved.id)

  await assert.rejects(
    contents(await store.resolveForDelivery(agent(), opened.handle)),
    /encrypted attachment payload is invalid/i,
  )
})

test('deferred delivery failures never expose the managed payload path', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'missing-later.txt')
  await writeFile(source, 'available while storing')
  let nextHandle = 0
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => `missing-later-${++nextHandle}` })
  const store = new EncryptedAttachmentStore({ root, crypto: memoryCrypto(), handles })
  const saved = await store.store(agent(), {
    recordId: 'record-1', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  })
  const managedPath = join(root, 'attachments', saved.sha256, 'original.enc')
  await rm(managedPath)
  const opened = await store.open(agent(), saved.id)

  await assert.rejects(
    contents(await store.resolveForDelivery(agent(), opened.handle)),
    (error: unknown) => error instanceof Error
      && /attachment open failed/i.test(error.message)
      && !error.message.includes(root),
  )
})

test('reference storage records encrypted metadata without copying the source payload', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'reference.pdf')
  await writeFile(source, '%PDF-reference')
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => 'capture-ref' })
  const store = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, createAttachmentId: () => 'attachment-ref',
  })

  const saved = await store.store(agent(), {
    recordId: 'record-1',
    handle: handles.mintCapture(agent(), { path: source }),
    storage: 'reference',
  })

  assert.equal(saved.storage, 'reference')
  assert.equal(saved.mimeType, 'application/pdf')
  await assert.rejects(readFile(join(root, 'attachments', saved.sha256!, 'original.enc')), { code: 'ENOENT' })
  const encryptedMetadata = await readFile(join(root, 'attachments', saved.sha256!, 'metadata.json'))
  assert.equal(encryptedMetadata.includes(Buffer.from(source)), false)
  await assert.rejects(store.open(agent(), saved.id), /not a managed copy/i)
})

test('plaintext SHA-256 deduplicates copies while tracking every referring record', async (t) => {
  const root = await temporaryRoot(t)
  const first = join(root, 'first.png')
  const second = join(root, 'second.png')
  await writeFile(first, Buffer.from('same image bytes'))
  await writeFile(second, Buffer.from('same image bytes'))
  let nextHandle = 0
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => `opaque-${++nextHandle}` })
  const store = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, createAttachmentId: () => 'attachment-shared',
  })

  const one = await store.store(agent(), {
    recordId: 'record-1', handle: handles.mintCapture(agent(), { path: first }), storage: 'copy',
  })
  const two = await store.store(agent(), {
    recordId: 'record-2', handle: handles.mintCapture(agent(), { path: second }), storage: 'copy',
  })

  assert.equal(two.id, one.id)
  assert.equal(two.liveReferenceCount, 2)
  assert.deepEqual((await readdir(join(root, 'attachments'))).filter((name) => !name.startsWith('.')), [one.sha256])
  assert.equal((await readdir(join(root, 'attachments', one.sha256!))).filter((name) => name === 'original.enc').length, 1)
})

test('large regular files default to references unless an explicit managed copy is requested', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'large.mov')
  await writeFile(source, Buffer.alloc(9, 0x41))
  let nextHandle = 0
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => `large-${++nextHandle}` })
  const store = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, maxManagedBytes: 8,
    createAttachmentId: (() => { let id = 0; return () => `attachment-${++id}` })(),
  })

  const referenced = await store.store(agent(), {
    recordId: 'record-1', handle: handles.mintCapture(agent(), { path: source }),
  })
  assert.equal(referenced.storage, 'reference')
  assert.equal(referenced.referenceReason, 'large-file')
  await assert.rejects(readFile(join(root, 'attachments', referenced.sha256!, 'original.enc')), { code: 'ENOENT' })

  const copied = await store.store(agent(), {
    recordId: 'record-2', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  })
  assert.equal(copied.storage, 'managed-copy')
  assert.equal(await stat(join(root, 'attachments', copied.sha256!, 'original.enc')).then(() => true), true)
})

test('an unreadable managed copy leaves no payload, metadata, or staging fragment', async (t) => {
  const root = await temporaryRoot(t)
  const missing = join(root, 'missing.txt')
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => 'missing-handle' })
  const store = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, createAttachmentId: () => 'attachment-missing',
  })

  await assert.rejects(
    store.store(agent(), {
      recordId: 'record-1', handle: handles.mintCapture(agent(), { path: missing }), storage: 'copy',
    }),
    /attachment copy failed/i,
  )
  assert.deepEqual(await readdir(join(root, 'attachments')), ['.staging'])
  assert.deepEqual(await readdir(join(root, 'attachments', '.staging')), [])
})

test('trash retains shared payloads until the final explicit purge boundary', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'shared.txt')
  await writeFile(source, 'shared')
  let nextHandle = 0
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => `shared-${++nextHandle}` })
  const store = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, createAttachmentId: () => 'attachment-shared',
  })
  const save = (recordId: string) => store.store(agent(), {
    recordId, handle: handles.mintCapture(agent(), { path: source }), storage: 'copy' as const,
  })
  const stored = await save('record-1')
  await save('record-2')

  await store.trashRecord('record-1')
  assert.deepEqual(await store.get(stored.id), {
    ...stored, liveReferenceCount: 1, trashReferenceCount: 1,
  })
  await store.purgeRecord('record-2')
  assert.equal((await store.get(stored.id)).trashReferenceCount, 1)
  await store.restoreRecord('record-1')
  assert.equal((await store.get(stored.id)).liveReferenceCount, 1)
  await store.trashRecord('record-1')
  await store.purgeRecord('record-1')
  await assert.rejects(store.get(stored.id), /not found/i)
  await assert.rejects(stat(join(root, 'attachments', stored.sha256!)), { code: 'ENOENT' })
})

test('capture handles expire, stay interaction-scoped, and reject model-supplied paths', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'capture.txt')
  await writeFile(source, 'capture')
  let now = NOW
  const handles = new InteractionAttachmentHandles({ now: () => now, createHandle: () => 'capture-handle' })
  const store = new EncryptedAttachmentStore({ root, crypto: memoryCrypto(), handles })
  const handle = handles.mintCapture(agent(), { path: source }, NOW + 5)

  await assert.rejects(
    store.store(agent('ix-2'), { recordId: 'record-1', handle, storage: 'copy' }),
    /attachment handle is invalid/i,
  )
  await assert.rejects(
    store.store(agent(), { recordId: 'record-1', path: source, storage: 'copy' } as never),
    /unsupported input/i,
  )
  now = NOW + 6
  await assert.rejects(
    store.store(agent(), { recordId: 'record-1', handle, storage: 'copy' }),
    /attachment handle is invalid/i,
  )
})

test('open handles are opaque, scoped to their Agent interaction, and expire', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'open.txt')
  await writeFile(source, 'open me')
  let now = NOW
  let nextHandle = 0
  const handles = new InteractionAttachmentHandles({ now: () => now, createHandle: () => `opaque-${++nextHandle}` })
  const store = new EncryptedAttachmentStore({ root, crypto: memoryCrypto(), handles })
  const saved = await store.store(agent(), {
    recordId: 'record-1', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  })
  const opened = await store.open(agent(), saved.id, NOW + 5)

  assert.equal(opened.handle.includes(saved.sha256!), false)
  assert.equal(opened.handle.includes('attachments'), false)
  await assert.rejects(store.resolveForDelivery(agent('ix-2'), opened.handle), /attachment handle is invalid/i)
  now = NOW + 6
  await assert.rejects(store.resolveForDelivery(agent(), opened.handle), /attachment handle is invalid/i)
})
