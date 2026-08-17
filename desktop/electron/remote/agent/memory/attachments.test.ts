import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  open as fsOpen,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises'
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

function delayedMemoryCrypto(delayMs: number): MemoryCrypto {
  return new MemoryCrypto({
    keyProvider: {
      async getMasterKey() {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
        return Buffer.from(MASTER_KEY)
      },
    },
  })
}

function controlledMemoryCrypto(blockCall: number) {
  let calls = 0
  let release!: () => void
  let reached!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const reachedBlock = new Promise<void>((resolve) => { reached = resolve })
  return {
    crypto: new MemoryCrypto({
      keyProvider: {
        async getMasterKey() {
          calls += 1
          if (calls === blockCall) {
            reached()
            await blocked
          }
          return Buffer.from(MASTER_KEY)
        },
      },
    }),
    reached: reachedBlock,
    release,
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await fsOpen(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

async function contents(attachment: DeliveryAttachment): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of attachment.open()) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function survivingDescriptor(
  store: EncryptedAttachmentStore,
  ...ids: string[]
) {
  for (const id of ids) {
    try { return await store.get(id) } catch { /* try the concurrently returned identity */ }
  }
  throw new Error('No concurrent attachment metadata survived')
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
  let consumed = 0

  await assert.rejects(
    async () => {
      for await (const chunk of (await store.resolveForDelivery(agent(), opened.handle)).open()) {
        consumed += chunk.byteLength
      }
    },
    /encrypted attachment payload is invalid/i,
  )
  assert.equal(consumed, 0)
})

test('managed copy rejects intact ciphertext substituted from another attachment identity', async (t) => {
  const root = await temporaryRoot(t)
  const sourceA = join(root, 'a.txt')
  const sourceB = join(root, 'b.txt')
  await writeFile(sourceA, 'attachment A')
  await writeFile(sourceB, 'attachment B with equal-ish size')
  let nextHandle = 0
  let nextId = 0
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => `substitute-${++nextHandle}` })
  const store = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, createAttachmentId: () => `attachment-${++nextId}`,
  })
  const savedA = await store.store(agent(), {
    recordId: 'record-a', handle: handles.mintCapture(agent(), { path: sourceA }), storage: 'copy',
  })
  const savedB = await store.store(agent(), {
    recordId: 'record-b', handle: handles.mintCapture(agent(), { path: sourceB }), storage: 'copy',
  })
  await copyFile(
    join(root, 'attachments', savedB.sha256, 'original.enc'),
    join(root, 'attachments', savedA.sha256, 'original.enc'),
  )
  const opened = await store.open(agent(), savedA.id)
  let consumed = 0

  await assert.rejects(
    async () => {
      for await (const chunk of (await store.resolveForDelivery(agent(), opened.handle)).open()) {
        consumed += chunk.byteLength
      }
    },
    /encrypted attachment payload is invalid/i,
  )
  assert.equal(consumed, 0)
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

test('two store instances atomically merge concurrent managed-copy references', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'concurrent-copy.bin')
  await writeFile(source, Buffer.alloc(256 * 1024, 0x63))
  let nextHandle = 0
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => `copy-race-${++nextHandle}` })
  const one = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, createAttachmentId: () => 'attachment-one',
  })
  const two = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, createAttachmentId: () => 'attachment-two',
  })

  const [savedOne, savedTwo] = await Promise.all([
    one.store(agent(), { recordId: 'record-1', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy' }),
    two.store(agent(), { recordId: 'record-2', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy' }),
  ])
  const saved = await survivingDescriptor(one, savedOne.id, savedTwo.id)

  assert.equal(saved.liveReferenceCount, 2)
  assert.equal(saved.storage, 'managed-copy')
  assert.equal((await readdir(join(root, 'attachments', saved.sha256))).filter((name) => name === 'original.enc').length, 1)
})

test('two store instances atomically merge concurrent reference-only records', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'concurrent-reference.bin')
  await writeFile(source, Buffer.alloc(128 * 1024, 0x72))
  let nextHandle = 0
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => `reference-race-${++nextHandle}` })
  const one = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, createAttachmentId: () => 'reference-one',
  })
  const two = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, createAttachmentId: () => 'reference-two',
  })

  const [savedOne, savedTwo] = await Promise.all([
    one.store(agent(), { recordId: 'record-1', handle: handles.mintCapture(agent(), { path: source }), storage: 'reference' }),
    two.store(agent(), { recordId: 'record-2', handle: handles.mintCapture(agent(), { path: source }), storage: 'reference' }),
  ])
  const saved = await survivingDescriptor(one, savedOne.id, savedTwo.id)

  assert.equal(saved.liveReferenceCount, 2)
  assert.equal(saved.storage, 'reference')
  await assert.rejects(readFile(join(root, 'attachments', saved.sha256, 'original.enc')), { code: 'ENOENT' })
})

test('reference-to-copy races converge on one managed identity with both record references', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'reference-copy-race.bin')
  await writeFile(source, Buffer.alloc(192 * 1024, 0x75))
  let nextHandle = 0
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => `upgrade-race-${++nextHandle}` })
  const referenceStore = new EncryptedAttachmentStore({
    root, crypto: delayedMemoryCrypto(75), handles, createAttachmentId: () => 'reference-identity',
  })
  const copyStore = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, createAttachmentId: () => 'copy-identity',
  })

  const [reference, copy] = await Promise.all([
    referenceStore.store(agent(), {
      recordId: 'record-reference', handle: handles.mintCapture(agent(), { path: source }), storage: 'reference',
    }),
    copyStore.store(agent(), {
      recordId: 'record-copy', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
    }),
  ])
  const saved = await survivingDescriptor(referenceStore, reference.id, copy.id)

  assert.equal(saved.storage, 'managed-copy')
  assert.equal(saved.liveReferenceCount, 2)
  assert.equal(await stat(join(root, 'attachments', saved.sha256, 'original.enc')).then(() => true), true)
})

test('startup quarantines a hash directory published without valid encrypted metadata', async (t) => {
  const root = await temporaryRoot(t)
  const sha256 = 'a'.repeat(64)
  const orphan = join(root, 'attachments', sha256)
  await mkdir(orphan, { recursive: true })
  await writeFile(join(orphan, 'original.enc'), 'orphan ciphertext')
  const store = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles: new InteractionAttachmentHandles({ now: () => NOW }),
  })

  await store.initialize()

  await assert.rejects(stat(orphan), { code: 'ENOENT' })
  assert.equal((await readdir(join(root, 'attachments', '.quarantine'))).some((name) => name.startsWith(sha256)), true)
})

test('startup cleans staging owned by a fenced hash lease without age-deleting unowned staging', async (t) => {
  const root = await temporaryRoot(t)
  const staging = join(root, 'attachments', '.staging')
  await mkdir(staging, { recursive: true })
  const sha256 = 'b'.repeat(64)
  const owned = join(staging, `.stage-${sha256}-crashed-owner.payload.tmp`)
  const unowned = join(staging, '.stage-unowned.payload.tmp')
  await writeFile(owned, 'abandoned ciphertext')
  await writeFile(unowned, 'unowned ciphertext')
  await utimes(unowned, new Date(0), new Date(0))
  await mkdir(join(root, 'attachments', sha256))
  const store = new EncryptedAttachmentStore({
    root,
    crypto: memoryCrypto(),
    handles: new InteractionAttachmentHandles({ now: () => NOW }),
    staleLockMs: 60_000,
  })

  await store.initialize()

  await assert.rejects(stat(owned), { code: 'ENOENT' })
  assert.equal((await stat(unowned)).isFile(), true)
})

test('stale per-hash locks recover, while a fresh lock times out without mutating attachment state', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'locked.txt')
  const bytes = Buffer.from('locked source')
  await writeFile(source, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const locks = join(root, 'attachments', '.locks')
  await mkdir(locks, { recursive: true })
  const lock = join(locks, `${sha256}.lock`)
  await mkdir(lock)
  await writeFile(join(lock, 'owner-crashed-owner'), '')
  await utimes(join(lock, 'owner-crashed-owner'), new Date(0), new Date(0))
  let nextHandle = 0
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => `lock-${++nextHandle}` })
  const recovering = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, staleLockMs: 50, lockTimeoutMs: 500,
  })
  const recovered = await recovering.store(agent(), {
    recordId: 'record-1', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  })
  assert.equal(recovered.liveReferenceCount, 1)

  await mkdir(lock)
  await writeFile(join(lock, 'owner-active-owner'), '')
  const blocked = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, staleLockMs: 60_000, lockTimeoutMs: 20,
  })
  await assert.rejects(
    blocked.store(agent(), {
      recordId: 'record-2', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
    }),
    /attachment lock timed out/i,
  )
  assert.equal((await recovering.get(recovered.id)).liveReferenceCount, 1)
})

test('a process crash immediately after creating the reaper gate does not wedge the hash', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'crashed-gate.txt')
  const bytes = Buffer.from('crashed reaper gate')
  await writeFile(source, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const locks = join(root, 'attachments', '.locks')
  const gate = join(locks, `${sha256}.reaper`)
  await mkdir(gate, { recursive: true })
  await utimes(gate, new Date(0), new Date(0))
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => 'crashed-gate-handle' })
  const store = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, staleLockMs: 25, lockTimeoutMs: 500, lockRetryMs: 5,
  })

  const saved = await store.store(agent(), {
    recordId: 'record-1', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  })

  assert.equal(saved.sha256, sha256)
  await assert.rejects(stat(gate), { code: 'ENOENT' })
})

test('a process crash after moving a reaper gate to its tombstone is recovered after a stale interval', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'crashed-reclaimer.txt')
  const bytes = Buffer.from('crashed stale reclaimer')
  await writeFile(source, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const tombstone = join(root, 'attachments', '.locks', `${sha256}.reaper-reclaim`)
  await mkdir(tombstone, { recursive: true })
  await writeFile(join(tombstone, 'owner-abandoned-gate'), '')
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => 'crashed-reclaimer-handle' })
  const store = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, staleLockMs: 25, lockTimeoutMs: 500, lockRetryMs: 5,
  })

  const saved = await store.store(agent(), {
    recordId: 'record-1', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  })

  assert.equal(saved.sha256, sha256)
  await assert.rejects(stat(tombstone), { code: 'ENOENT' })
})

test('two simultaneous stores safely converge while recovering one abandoned reaper tombstone', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'two-gate-reclaimers.txt')
  const bytes = Buffer.from('two gate reclaimers')
  await writeFile(source, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const tombstone = join(root, 'attachments', '.locks', `${sha256}.reaper-reclaim`)
  await mkdir(tombstone, { recursive: true })
  await writeFile(join(tombstone, 'owner-abandoned-gate'), '')
  const handles = new InteractionAttachmentHandles({
    now: () => NOW,
    createHandle: (() => { let value = 0; return () => `gate-reclaimer-${++value}` })(),
  })
  const first = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, staleLockMs: 25, lockTimeoutMs: 1_000, lockRetryMs: 5,
    createAttachmentId: () => 'gate-reclaimer-first',
  })
  const second = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, staleLockMs: 25, lockTimeoutMs: 1_000, lockRetryMs: 5,
    createAttachmentId: () => 'gate-reclaimer-second',
  })

  const [savedFirst, savedSecond] = await Promise.all([
    first.store(agent(), {
      recordId: 'record-first', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
    }),
    second.store(agent(), {
      recordId: 'record-second', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
    }),
  ])
  const saved = await survivingDescriptor(first, savedFirst.id, savedSecond.id)

  assert.equal(saved.liveReferenceCount, 2)
  await assert.rejects(stat(tombstone), { code: 'ENOENT' })
})

test('a fresh gate found inside the reclaim tombstone is restored instead of reaped', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'fresh-gate.txt')
  const bytes = Buffer.from('fresh gate owner')
  await writeFile(source, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const locks = join(root, 'attachments', '.locks')
  const gate = join(locks, `${sha256}.reaper`)
  const tombstone = join(locks, `${sha256}.reaper-reclaim`)
  const freshOwner = join(tombstone, 'owner-live-gate')
  await mkdir(tombstone, { recursive: true })
  await writeFile(freshOwner, '')
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => 'fresh-gate-handle' })
  const store = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, staleLockMs: 50, lockTimeoutMs: 180, lockRetryMs: 5,
  })
  const heartbeat = setInterval(() => {
    const now = new Date()
    void Promise.all([
      utimes(freshOwner, now, now),
      utimes(join(gate, 'owner-live-gate'), now, now),
    ].map((refresh) => refresh.catch(() => { /* exactly one location exists */ })))
  }, 5)
  heartbeat.unref()

  try {
    await assert.rejects(store.store(agent(), {
      recordId: 'record-1', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
    }), /attachment lock timed out/i)
  } finally {
    clearInterval(heartbeat)
  }

  assert.equal((await stat(join(gate, 'owner-live-gate'))).isFile(), true)
  await assert.rejects(stat(tombstone), { code: 'ENOENT' })
})

test('an active owner heartbeats across stale intervals and serializes a waiting writer', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'heartbeat.txt')
  await writeFile(source, 'heartbeat lease')
  let nextHandle = 0
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => `heartbeat-${++nextHandle}` })
  const controlled = controlledMemoryCrypto(2)
  const owner = new EncryptedAttachmentStore({
    root, crypto: controlled.crypto, handles, staleLockMs: 45, lockTimeoutMs: 1_000, lockRetryMs: 5,
    createAttachmentId: () => 'heartbeat-owner',
  })
  const waiter = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, staleLockMs: 45, lockTimeoutMs: 1_000, lockRetryMs: 5,
    createAttachmentId: () => 'heartbeat-waiter',
  })
  const ownerSave = owner.store(agent(), {
    recordId: 'record-owner', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  })
  await controlled.reached
  let waiterSettled = false
  const waiterSave = waiter.store(agent(), {
    recordId: 'record-waiter', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  }).finally(() => { waiterSettled = true })

  await wait(160)
  assert.equal(waiterSettled, false)
  controlled.release()
  const [savedOwner, savedWaiter] = await Promise.all([ownerSave, waiterSave])
  const saved = await survivingDescriptor(owner, savedOwner.id, savedWaiter.id)
  assert.equal(saved.liveReferenceCount, 2)
})

test('two simultaneous stale reclaimers are gated and merge after fencing one stalled owner', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'two-reclaimers.txt')
  await writeFile(source, 'two stale reclaimers')
  let nextHandle = 0
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => `reaper-${++nextHandle}` })
  const stalledCrypto = controlledMemoryCrypto(2)
  const noHeartbeat = { start() { return async () => {} } }
  const stalled = new EncryptedAttachmentStore({
    root, crypto: stalledCrypto.crypto, handles, staleLockMs: 35, lockTimeoutMs: 1_000, lockRetryMs: 5,
    leaseHeartbeat: noHeartbeat,
    createAttachmentId: () => 'stalled-owner',
  })
  const firstSave = stalled.store(agent(), {
    recordId: 'record-stalled', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  })
  await stalledCrypto.reached
  await wait(70)
  const first = new EncryptedAttachmentStore({
    root, crypto: delayedMemoryCrypto(55), handles, staleLockMs: 35, lockTimeoutMs: 1_000, lockRetryMs: 5,
    createAttachmentId: () => 'first-reclaimer',
  })
  const second = new EncryptedAttachmentStore({
    root, crypto: delayedMemoryCrypto(55), handles, staleLockMs: 35, lockTimeoutMs: 1_000, lockRetryMs: 5,
    createAttachmentId: () => 'second-reclaimer',
  })
  const reclaimers = Promise.all([
    first.store(agent(), {
      recordId: 'record-first', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
    }),
    second.store(agent(), {
      recordId: 'record-second', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
    }),
  ])
  const [savedFirst, savedSecond] = await reclaimers
  stalledCrypto.release()
  await assert.rejects(firstSave, /attachment lease was fenced/i)
  const saved = await survivingDescriptor(first, savedFirst.id, savedSecond.id)
  assert.equal(saved.liveReferenceCount, 2)
})

test('a fenced stalled owner cannot publish when it resumes', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'fenced-owner.txt')
  await writeFile(source, 'fenced owner')
  let nextHandle = 0
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => `fenced-${++nextHandle}` })
  const controlled = controlledMemoryCrypto(2)
  const stalled = new EncryptedAttachmentStore({
    root, crypto: controlled.crypto, handles, staleLockMs: 30, lockTimeoutMs: 1_000, lockRetryMs: 5,
    leaseHeartbeat: { start() { return async () => {} } },
    createAttachmentId: () => 'fenced-old',
  })
  const replacement = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, staleLockMs: 30, lockTimeoutMs: 1_000, lockRetryMs: 5,
    createAttachmentId: () => 'fenced-new',
  })
  const oldSave = stalled.store(agent(), {
    recordId: 'record-old', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  })
  await controlled.reached
  await wait(65)
  const saved = await replacement.store(agent(), {
    recordId: 'record-new', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  })
  controlled.release()

  await assert.rejects(oldSave, /attachment lease was fenced/i)
  assert.equal((await replacement.get(saved.id)).liveReferenceCount, 1)
  const opened = await replacement.open(agent(), saved.id)
  assert.equal(await contents(await replacement.resolveForDelivery(agent(), opened.handle)).then(String), 'fenced owner')
})

test('a fenced owner paused before canonical directory creation cannot recreate successor-cleaned state', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'fenced-before-directory.txt')
  const bytes = Buffer.from('fenced before canonical directory')
  await writeFile(source, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const hashDirectory = join(root, 'attachments', sha256)
  let nextHandle = 0
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => `directory-fence-${++nextHandle}` })
  const controlled = controlledMemoryCrypto(2)
  const stalled = new EncryptedAttachmentStore({
    root, crypto: controlled.crypto, handles, staleLockMs: 30, lockTimeoutMs: 1_000, lockRetryMs: 5,
    leaseHeartbeat: { start() { return async () => {} } },
  })
  await stalled.initialize()
  await mkdir(hashDirectory)
  await writeFile(join(hashDirectory, 'metadata.json'), await memoryCrypto().encrypt('invalid metadata'))
  const oldSave = stalled.store(agent(), {
    recordId: 'record-old', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  })
  await controlled.reached
  await wait(65)
  const successor = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, staleLockMs: 30, lockTimeoutMs: 1_000, lockRetryMs: 5,
  })

  await successor.initialize()
  await assert.rejects(stat(hashDirectory), { code: 'ENOENT' })
  controlled.release()
  await assert.rejects(oldSave, /attachment lease was fenced/i)

  await assert.rejects(stat(hashDirectory), { code: 'ENOENT' })
  assert.equal((await readdir(join(root, 'attachments', '.quarantine'))).some((name) => name.startsWith(sha256)), true)
})

test('a fenced owner release cannot remove the replacement lease', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'release-race.txt')
  await writeFile(source, 'release replacement')
  let nextHandle = 0
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => `release-${++nextHandle}` })
  const oldCrypto = controlledMemoryCrypto(2)
  const newCrypto = controlledMemoryCrypto(2)
  const old = new EncryptedAttachmentStore({
    root, crypto: oldCrypto.crypto, handles, staleLockMs: 30, lockTimeoutMs: 1_000, lockRetryMs: 5,
    leaseHeartbeat: { start() { return async () => {} } },
  })
  const replacement = new EncryptedAttachmentStore({
    root, crypto: newCrypto.crypto, handles, staleLockMs: 30, lockTimeoutMs: 1_000, lockRetryMs: 5,
  })
  const oldSave = old.store(agent(), {
    recordId: 'record-old', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  })
  await oldCrypto.reached
  await wait(65)
  const replacementSave = replacement.store(agent(), {
    recordId: 'record-new', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  })
  await newCrypto.reached
  oldCrypto.release()
  await assert.rejects(oldSave, /attachment lease was fenced/i)

  const blocked = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, staleLockMs: 1_000, lockTimeoutMs: 25, lockRetryMs: 5,
  })
  await assert.rejects(blocked.store(agent(), {
    recordId: 'record-third', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  }), /attachment lock timed out/i)
  newCrypto.release()
  await replacementSave
})

test('startup recovery waits for a live heartbeating writer and does not quarantine its in-flight hash', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'live-recovery.txt')
  const bytes = Buffer.from('live recovery')
  await writeFile(source, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  let nextHandle = 0
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => `recovery-${++nextHandle}` })
  const controlled = controlledMemoryCrypto(2)
  const writer = new EncryptedAttachmentStore({
    root, crypto: controlled.crypto, handles, staleLockMs: 40, lockTimeoutMs: 1_000, lockRetryMs: 5,
  })
  const write = writer.store(agent(), {
    recordId: 'record-live', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  })
  await controlled.reached
  const recovery = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, staleLockMs: 40, lockTimeoutMs: 1_000, lockRetryMs: 5,
  })
  let recovered = false
  const initialize = recovery.initialize().then(() => { recovered = true })
  await wait(140)
  assert.equal(recovered, false)
  controlled.release()
  const saved = await write
  await initialize

  assert.equal(saved.sha256, sha256)
  assert.equal((await stat(join(root, 'attachments', sha256, 'original.enc'))).isFile(), true)
  assert.equal((await readdir(join(root, 'attachments', '.quarantine'))).length, 0)
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
  assert.deepEqual((await readdir(join(root, 'attachments'))).filter((name) => !name.startsWith('.')), [])
  assert.deepEqual(await readdir(join(root, 'attachments', '.staging')), [])
})

test('metadata directory fsync failure after rename keeps the committed payload readable and retryable', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'durability.txt')
  const bytes = Buffer.from('durability uncertain')
  await writeFile(source, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const attachmentDir = join(root, 'attachments', sha256)
  let attachmentSyncs = 0
  let failOnce = true
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: (() => {
    let value = 0
    return () => `durability-${++value}`
  })() })
  const store = new EncryptedAttachmentStore({
    root,
    crypto: memoryCrypto(),
    handles,
    createAttachmentId: () => 'attachment-durability',
    async directorySync(path: string) {
      if (path === attachmentDir) {
        attachmentSyncs += 1
        if (attachmentSyncs === 2 && failOnce) {
          failOnce = false
          throw new Error('forced metadata directory fsync failure')
        }
      }
      await syncDirectory(path)
    },
  })
  const firstHandle = handles.mintCapture(agent(), { path: source })

  await assert.rejects(
    store.store(agent(), { recordId: 'record-1', handle: firstHandle, storage: 'copy' }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'durability-uncertain',
  )
  assert.equal((await stat(join(attachmentDir, 'original.enc'))).isFile(), true)
  assert.equal((await store.get('attachment-durability')).liveReferenceCount, 1)

  const retried = await store.store(agent(), {
    recordId: 'record-1', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  })
  const opened = await store.open(agent(), retried.id)
  assert.deepEqual(await contents(await store.resolveForDelivery(agent(), opened.handle)), bytes)
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

test('capture handles reject separators, traversal, control characters, and path-like source names', () => {
  let nextHandle = 0
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => `unsafe-${++nextHandle}` })

  for (const name of [
    '../secret.txt',
    'folder/secret.txt',
    'folder\\secret.txt',
    '/absolute.txt',
    'C:\\absolute.txt',
    'bad\nname.txt',
    'bad\u0085name.txt',
    '.',
    '..',
  ]) {
    assert.throws(
      () => handles.mintCapture(agent(), { path: '/trusted/source.txt', name }),
      /capture attachment is invalid/i,
      name,
    )
  }
})

test('managed copy refuses a symlink source instead of following it', async (t) => {
  const root = await temporaryRoot(t)
  const target = join(root, 'target.txt')
  const source = join(root, 'link.txt')
  await writeFile(target, 'secret target')
  await symlink(target, source)
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => 'symlink-handle' })
  const store = new EncryptedAttachmentStore({ root, crypto: memoryCrypto(), handles })

  await assert.rejects(
    store.store(agent(), {
      recordId: 'record-1', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
    }),
    /attachment copy failed/i,
  )
  assert.deepEqual((await readdir(join(root, 'attachments'))).filter((name) => !name.startsWith('.')), [])
})

test('source is opened once with no-follow and a path swap cannot change the descriptor being copied', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'source.txt')
  const replacement = join(root, 'replacement.txt')
  const archived = join(root, 'opened-source.txt')
  await writeFile(source, 'descriptor bytes')
  await writeFile(replacement, 'replacement path bytes')
  let openCount = 0
  let observedFlags = 0
  const sourceFileSystem = {
    async open(path: string, flags: number) {
      openCount += 1
      observedFlags = flags
      const file = await fsOpen(path, flags)
      let swapped = false
      return {
        async stat() {
          const value = await file.stat()
          if (!swapped) {
            swapped = true
            await rename(source, archived)
            await rename(replacement, source)
          }
          return value
        },
        read: file.read.bind(file),
        close: file.close.bind(file),
      }
    },
  }
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: (() => {
    let next = 0
    return () => `swap-${++next}`
  })() })
  const store = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, sourceFileSystem,
  })

  const saved = await store.store(agent(), {
    recordId: 'record-1', handle: handles.mintCapture(agent(), { path: source }), storage: 'copy',
  })
  const opened = await store.open(agent(), saved.id)

  assert.equal(openCount, 1)
  assert.equal((observedFlags & constants.O_NOFOLLOW) !== 0, true)
  assert.equal(await contents(await store.resolveForDelivery(agent(), opened.handle)).then(String), 'descriptor bytes')
})

test('a source that grows beyond the implicit copy ceiling becomes a reference during descriptor reads', async (t) => {
  const root = await temporaryRoot(t)
  const source = join(root, 'growing.bin')
  await writeFile(source, 'tiny')
  let openCount = 0
  const sourceFileSystem = {
    async open(path: string, flags: number) {
      openCount += 1
      const file = await fsOpen(path, flags)
      let grown = false
      return {
        async stat() {
          const value = await file.stat()
          if (!grown) {
            grown = true
            await appendFile(source, Buffer.alloc(32, 0x67))
          }
          return value
        },
        read: file.read.bind(file),
        close: file.close.bind(file),
      }
    },
  }
  const handles = new InteractionAttachmentHandles({ now: () => NOW, createHandle: () => 'growing-handle' })
  const store = new EncryptedAttachmentStore({
    root, crypto: memoryCrypto(), handles, maxManagedBytes: 8, sourceFileSystem,
  })

  const saved = await store.store(agent(), {
    recordId: 'record-1', handle: handles.mintCapture(agent(), { path: source }),
  })

  assert.equal(openCount, 1)
  assert.equal(saved.storage, 'reference')
  assert.equal(saved.referenceReason, 'large-file')
  assert.equal(saved.size, 36)
  await assert.rejects(readFile(join(root, 'attachments', saved.sha256, 'original.enc')), { code: 'ENOENT' })
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
