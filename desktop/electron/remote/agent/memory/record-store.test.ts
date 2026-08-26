import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'

import { MemoryCrypto } from './crypto.ts'
import {
  EncryptedRecordStore,
  deserializeMemoryRecord,
  presentMemoryRecord,
  serializeMemoryRecord,
  type RecordStoreFileSystem,
} from './record-store.ts'
import type { CreateMemoryRecordInput, MemoryRecord } from './types.ts'

const MASTER_KEY = Buffer.alloc(32, 0x4d)
const NOW = 1_723_456_789_000

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'unmute-record-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function memoryCrypto(): MemoryCrypto {
  return new MemoryCrypto({
    keyProvider: { async getMasterKey() { return Buffer.from(MASTER_KEY) } },
  })
}

function input(overrides: Partial<CreateMemoryRecordInput> = {}): CreateMemoryRecordInput {
  return {
    kind: 'guidance',
    title: 'Project Atlas voice',
    content: 'Use **short**, direct sentences.\n\nKeep the launch name intact.',
    tags: ['atlas', 'voice'],
    links: [],
    scope: { app: 'Slack', project: 'Atlas', purpose: 'writing' },
    attachments: ['attachment-1'],
    references: [{ type: 'url', value: 'https://example.com/atlas' }],
    provenance: { source: 'voice', original: 'Remember my Atlas voice' },
    ...overrides,
  }
}

function store(root: string, options: {
  fileSystem?: RecordStoreFileSystem
  createId?: () => string
  now?: () => number
} = {}): EncryptedRecordStore {
  return new EncryptedRecordStore({
    root,
    crypto: memoryCrypto(),
    createId: options.createId ?? (() => 'memory-1'),
    now: options.now ?? (() => NOW),
    fileSystem: options.fileSystem,
  })
}

function nodeFileSystem(overrides: Partial<RecordStoreFileSystem> = {}): RecordStoreFileSystem {
  return {
    async mkdir(path, options) { await mkdir(path, options) },
    readFile: (path) => readFile(path),
    open: (path, flags, mode) => open(path, flags, mode),
    async link(existingPath, newPath) { await link(existingPath, newPath) },
    async rename(oldPath, newPath) { await rename(oldPath, newPath) },
    readdir: (path, options) => readdir(path, options),
    async unlink(path) { await unlink(path) },
    ...overrides,
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('rejects invalid records and generated identifiers before writing', async (t) => {
  const root = await temporaryRoot(t)

  await assert.rejects(() => store(root).create(input({ title: '  ' })), /title/i)
  await assert.rejects(
    () => store(root, { createId: () => '../outside' }).create(input()),
    /identifier/i,
  )
  await assert.rejects(
    () => store(root).create(input({ references: [{ type: 'url', value: '' }] })),
    /reference/i,
  )
  await assert.rejects(() => readFile(join(root, 'records', 'memory-1.md.enc')), { code: 'ENOENT' })
})

test('rejects runtime create fields that could override canonical store identity', async (t) => {
  const root = await temporaryRoot(t)
  const untypedInput = { ...input(), id: 'different-id', version: 99 }

  await assert.rejects(
    () => store(root).create(untypedInput as CreateMemoryRecordInput),
    /create input/i,
  )
  await assert.rejects(() => readFile(join(root, 'records', 'memory-1.md.enc')), { code: 'ENOENT' })
})

test('accepts a service-journaled identifier without consulting the fallback generator', async (t) => {
  const root = await temporaryRoot(t)
  const records = store(root, { createId: () => { throw new Error('fallback must not run') } })

  const created = await records.create(input(), 'memory-journaled')

  assert.equal(created.id, 'memory-journaled')
  assert.equal((await records.read('memory-journaled')).id, 'memory-journaled')
})

test('serializes deterministic metadata and Markdown in a versioned JSON payload', () => {
  const record: MemoryRecord = {
    id: 'memory-1',
    kind: 'note',
    title: 'A: title',
    content: '# Body\n\nText',
    tags: ['two', 'one'],
    links: [],
    attachments: [],
    references: [],
    provenance: { source: 'import' },
    createdAt: 10,
    updatedAt: 20,
    version: 3,
  }

  assert.equal(serializeMemoryRecord(record), JSON.stringify({
    format: 'unmute-memory-record',
    serializerVersion: 4,
    document: [
      '---',
      'serializerVersion: 4',
      'id: "memory-1"',
      'kind: "note"',
      'title: "A: title"',
      'summary: null',
      'contentPresent: true',
      'tags: ["two","one"]',
      'links: []',
      'scope: null',
      'attachments: []',
      'references: []',
      'provenance: {"source":"import"}',
      'createdAt: 10',
      'updatedAt: 20',
      'version: 3',
      'deletedAt: null',
      '---',
      '# Body\n\nText',
    ].join('\n'),
  }))
})

test('serializes nested metadata deterministically regardless of property insertion order', () => {
  const common: MemoryRecord = {
    id: 'memory-1',
    kind: 'reference',
    title: 'Reference',
    tags: [],
    links: [],
    attachments: [],
    references: [{ type: 'url', value: 'https://example.com' }],
    provenance: { source: 'import', original: 'source' },
    scope: { app: 'Browser', project: 'Atlas', purpose: 'research' },
    createdAt: 10,
    updatedAt: 10,
    version: 1,
  }
  const reordered: MemoryRecord = {
    ...common,
    scope: { purpose: 'research', project: 'Atlas', app: 'Browser' },
    references: [{ value: 'https://example.com', type: 'url' }],
    provenance: { original: 'source', source: 'import' },
  }

  assert.equal(serializeMemoryRecord(reordered), serializeMemoryRecord(common))
})

test('reads legacy sensitivity metadata without preserving or rewriting the concept', () => {
  const current: MemoryRecord = {
    id: 'legacy-private', kind: 'document', title: 'Resume', tags: [], links: [],
    attachments: ['resume-file'], references: [], provenance: { source: 'attachment' },
    createdAt: 10, updatedAt: 10, version: 1,
  }
  const envelope = JSON.parse(serializeMemoryRecord(current)) as {
    serializerVersion: number
    document: string
  }
  envelope.serializerVersion = 3
  envelope.document = envelope.document
    .replace('serializerVersion: 4', 'serializerVersion: 3')
    .replace('scope: null\n', 'scope: null\nsensitivity: "private"\n')

  const restored = deserializeMemoryRecord(JSON.stringify(envelope))

  assert.deepEqual(restored, current)
  assert.equal(serializeMemoryRecord(restored).includes('sensitivity:'), false)
})

test('round-trips absent content distinctly from explicit empty Markdown', () => {
  const withoutContent: MemoryRecord = {
    id: 'without-content', kind: 'note', title: 'Absent', tags: [], links: [],
    attachments: [], references: [],
    provenance: { source: 'import' }, createdAt: 10, updatedAt: 10, version: 1,
  }
  const withEmptyContent: MemoryRecord = {
    ...withoutContent, id: 'empty-content', title: 'Empty', content: '',
  }

  assert.deepEqual(deserializeMemoryRecord(serializeMemoryRecord(withoutContent)), withoutContent)
  assert.deepEqual(deserializeMemoryRecord(serializeMemoryRecord(withEmptyContent)), withEmptyContent)
  assert.notEqual(serializeMemoryRecord(withoutContent), serializeMemoryRecord(withEmptyContent))
})

test('creates and reads only an encrypted canonical <id>.md.enc record', async (t) => {
  const root = await temporaryRoot(t)
  const records = store(root)

  const created = await records.create(input())
  const canonicalPath = join(root, 'records', 'memory-1.md.enc')
  const encrypted = await readFile(canonicalPath)
  const decrypted = await memoryCrypto().decrypt(encrypted)

  assert.deepEqual(created, {
    id: 'memory-1',
    ...input(),
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  })
  assert.deepEqual(await records.read('memory-1'), created)
  assert.equal(encrypted.includes(Buffer.from(created.title)), false)
  assert.equal(encrypted.includes(Buffer.from(created.content ?? '')), false)
  assert.equal(JSON.parse(decrypted.toString('utf8')).format, 'unmute-memory-record')
  assert.deepEqual(await readdir(join(root, 'records')), ['memory-1.md.enc'])
})

test('publishes a create only after staging, fsync, close, and an atomic no-replace link', async (t) => {
  const root = await temporaryRoot(t)
  const events: string[] = []
  const fs = nodeFileSystem({
    async open(path, flags, mode) {
      events.push(`open:${basename(path)}:${flags}:${mode.toString(8)}`)
      const handle = await open(path, flags, mode)
      return {
        async writeFile(data) { events.push('write'); await handle.writeFile(data) },
        async sync() { events.push('sync'); await handle.sync() },
        async close() { events.push('close'); await handle.close() },
      }
    },
    async rename(oldPath, newPath) {
      events.push(`rename:${basename(oldPath)}:${basename(newPath)}`)
      await rename(oldPath, newPath)
    },
    async link(existingPath, newPath) {
      events.push(`link:${basename(existingPath)}:${basename(newPath)}`)
      await link(existingPath, newPath)
    },
  })

  await store(root, { fileSystem: fs }).create(input())

  assert.match(events[0], /^open:\.stage-memory-1\..+\.tmp:wx:600$/)
  assert.deepEqual(events.slice(1, 4), ['write', 'sync', 'close'])
  assert.match(events[4], /^link:\.stage-memory-1\..+\.tmp:memory-1\.md\.enc$/)
})

test('updates atomically, increments the version, and snapshots the complete prior envelope', async (t) => {
  const root = await temporaryRoot(t)
  const records = store(root, { now: (() => {
    const times = [NOW, NOW + 1_000]
    return () => times.shift() ?? NOW + 1_000
  })() })
  await records.create(input())
  const canonicalPath = join(root, 'records', 'memory-1.md.enc')
  const priorEnvelope = await readFile(canonicalPath)

  const updated = await records.update('memory-1', {
    title: 'Project Atlas written voice',
    content: 'Prefer active voice.',
    tags: ['atlas', 'writing'],
    links: [],
  })

  assert.equal(updated.version, 2)
  assert.equal(updated.createdAt, NOW)
  assert.equal(updated.updatedAt, NOW + 1_000)
  assert.deepEqual(await readFile(join(root, 'versions', 'memory-1', '1.json.enc')), priorEnvelope)
  assert.deepEqual(await records.readVersion('memory-1', 1), {
    id: 'memory-1',
    ...input(),
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  })
  assert.deepEqual(await records.read('memory-1'), updated)
})

test('forget moves the encrypted record to recoverable trash and retains versions', async (t) => {
  const root = await temporaryRoot(t)
  const records = store(root)
  await records.create(input())
  await records.update('memory-1', { title: 'Updated title' })
  const currentEnvelope = await readFile(join(root, 'records', 'memory-1.md.enc'))
  const versionEnvelope = await readFile(join(root, 'versions', 'memory-1', '1.json.enc'))

  await records.forget('memory-1')

  await assert.rejects(() => records.read('memory-1'), { code: 'not-found' })
  assert.deepEqual(await readFile(join(root, 'trash', 'records', 'memory-1.md.enc')), currentEnvelope)
  assert.deepEqual(await readFile(join(root, 'versions', 'memory-1', '1.json.enc')), versionEnvelope)
  assert.equal((await records.readTrash('memory-1')).title, 'Updated title')
  assert.equal('purge' in records, false)
})

test('restore reverses forget without rewriting the encrypted record', async (t) => {
  const root = await temporaryRoot(t)
  const records = store(root)
  await records.create(input())
  await records.forget('memory-1')
  const trashedEnvelope = await readFile(join(root, 'trash', 'records', 'memory-1.md.enc'))

  await records.restore('memory-1')

  assert.deepEqual(await readFile(join(root, 'records', 'memory-1.md.enc')), trashedEnvelope)
  assert.deepEqual(await records.read('memory-1'), {
    id: 'memory-1',
    ...input(),
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  })
  await assert.rejects(() => records.readTrash('memory-1'), { code: 'not-found' })
})

test('lists active and trash canonical truth in stable identifier order for index rebuild', async (t) => {
  const root = await temporaryRoot(t)
  const identifiers = ['memory-b', 'memory-a']
  const records = store(root, { createId: () => identifiers.shift() ?? 'unexpected-id' })
  const trashed = await records.create(input({ title: 'Trashed record' }))
  const active = await records.create(input({ title: 'Active record' }))
  await records.forget(trashed.id)

  const canonical = await records.list()

  assert.deepEqual(canonical, [
    active,
    { ...trashed, deletedAt: trashed.updatedAt },
  ])
  assert.equal(JSON.stringify(canonical).includes(root), false)
})

test('keeps unknown future kinds canonical and degrades them only for presentation', async (t) => {
  const root = await temporaryRoot(t)
  const records = store(root)
  const created = await records.create(input({ kind: 'future-spatial-memory' }))

  assert.equal(created.kind, 'future-spatial-memory')
  assert.equal((await records.read('memory-1')).kind, 'future-spatial-memory')
  assert.equal(presentMemoryRecord(created).kind, 'note')
  assert.equal((await records.read('memory-1')).kind, 'future-spatial-memory')
})

test('startup recovery removes abandoned staging files without touching canonical data', async (t) => {
  const root = await temporaryRoot(t)
  const records = store(root)
  await records.create(input())
  const stagingPaths = [
    join(root, 'records', '.stage-abandoned.tmp'),
    join(root, 'trash', 'records', '.stage-abandoned.tmp'),
    join(root, 'versions', 'memory-1', '.stage-abandoned.tmp'),
  ]
  await mkdir(join(root, 'trash', 'records'), { recursive: true })
  await mkdir(join(root, 'versions', 'memory-1'), { recursive: true })
  await Promise.all(stagingPaths.map((path) => writeFile(path, Buffer.from('partial plaintext'))))

  await store(root).initialize()

  for (const path of stagingPaths) {
    await assert.rejects(() => readFile(path), { code: 'ENOENT' })
  }
  assert.equal((await records.read('memory-1')).title, input().title)
})

test('an injected staged-write failure leaves the prior canonical version intact', async (t) => {
  const root = await temporaryRoot(t)
  const healthy = store(root)
  await healthy.create(input())
  const canonicalPath = join(root, 'records', 'memory-1.md.enc')
  const priorEnvelope = await readFile(canonicalPath)
  const fs = nodeFileSystem({
    async open(path, flags, mode) {
      const handle = await open(path, flags, mode)
      return {
        async writeFile(data) {
          if (dirname(path) === join(root, 'records')) throw new Error('injected record write failure')
          await handle.writeFile(data)
        },
        async sync() { await handle.sync() },
        async close() { await handle.close() },
      }
    },
  })

  await assert.rejects(
    () => store(root, { fileSystem: fs }).update('memory-1', { title: 'Must not publish' }),
    (error: Error & { code?: string }) => error.code === 'storage-failure',
  )
  assert.deepEqual(await readFile(canonicalPath), priorEnvelope)
  assert.deepEqual(await healthy.read('memory-1'), {
    id: 'memory-1',
    ...input(),
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  })
})

test('an injected final-rename failure leaves the prior canonical version intact', async (t) => {
  const root = await temporaryRoot(t)
  const healthy = store(root)
  await healthy.create(input())
  const canonicalPath = join(root, 'records', 'memory-1.md.enc')
  const priorEnvelope = await readFile(canonicalPath)
  const fs = nodeFileSystem({
    async rename(oldPath, newPath) {
      if (newPath === canonicalPath) throw new Error('injected record rename failure')
      await rename(oldPath, newPath)
    },
  })

  await assert.rejects(
    () => store(root, { fileSystem: fs }).update('memory-1', { title: 'Must not publish' }),
    (error: Error & { code?: string }) => error.code === 'storage-failure',
  )
  assert.deepEqual(await readFile(canonicalPath), priorEnvelope)
  assert.equal((await healthy.read('memory-1')).version, 1)
  assert.deepEqual(await readdir(join(root, 'records')), ['memory-1.md.enc'])
})

test('concurrent creates atomically claim the absent destination without overwrite', async (t) => {
  const root = await temporaryRoot(t)
  const bothPublishing = deferred()
  let publicationCount = 0
  async function pausePublication(): Promise<void> {
    publicationCount += 1
    if (publicationCount === 2) bothPublishing.resolve()
    await bothPublishing.promise
  }
  const canonicalPath = join(root, 'records', 'memory-1.md.enc')
  const fs = nodeFileSystem({
    async link(existingPath, newPath) {
      if (newPath === canonicalPath) await pausePublication()
      await link(existingPath, newPath)
    },
    async rename(oldPath, newPath) {
      if (newPath === canonicalPath) await pausePublication()
      await rename(oldPath, newPath)
    },
  })
  const records = store(root, { fileSystem: fs })

  const outcomes = await Promise.allSettled([
    records.create(input({ title: 'First contender' })),
    records.create(input({ title: 'Second contender' })),
  ])

  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter(({ status }) => status === 'rejected').length, 1)
  assert.match((outcomes.find(({ status }) => status === 'rejected') as PromiseRejectedResult).reason.message, /already exists/i)
  assert.match((await records.read('memory-1')).title, /^(First|Second) contender$/)
})

test('the version snapshot is a no-replace claim that permits only one simultaneous update', async (t) => {
  const root = await temporaryRoot(t)
  const healthy = store(root)
  await healthy.create(input())
  const bothClaiming = deferred()
  let claimCount = 0
  const claimPath = join(root, 'versions', 'memory-1', '1.json.enc')
  async function pauseClaim(): Promise<void> {
    claimCount += 1
    if (claimCount === 2) bothClaiming.resolve()
    await bothClaiming.promise
  }
  const fs = nodeFileSystem({
    async link(existingPath, newPath) {
      if (newPath === claimPath) await pauseClaim()
      await link(existingPath, newPath)
    },
    async rename(oldPath, newPath) {
      if (newPath === claimPath) await pauseClaim()
      await rename(oldPath, newPath)
    },
  })
  const records = store(root, { fileSystem: fs })

  const outcomes = await Promise.allSettled([
    records.update('memory-1', { title: 'First update' }),
    records.update('memory-1', { title: 'Second update' }),
  ])

  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter(({ status }) => status === 'rejected').length, 1)
  assert.match((outcomes.find(({ status }) => status === 'rejected') as PromiseRejectedResult).reason.message, /concurrent update/i)
  assert.equal((await records.read('memory-1')).version, 2)
  assert.equal((await records.readVersion('memory-1', 1)).version, 1)
})

async function assertMoveCollisionDoesNotOverwrite(
  root: string,
  operation: 'forget' | 'restore',
): Promise<void> {
  const healthy = store(root)
  await healthy.create(input())
  if (operation === 'restore') await healthy.forget('memory-1')
  const source = operation === 'forget'
    ? join(root, 'records', 'memory-1.md.enc')
    : join(root, 'trash', 'records', 'memory-1.md.enc')
  const destination = operation === 'forget'
    ? join(root, 'trash', 'records', 'memory-1.md.enc')
    : join(root, 'records', 'memory-1.md.enc')
  const sourceEnvelope = await readFile(source)
  const reachedCollisionWindow = deferred()
  const releaseCollisionWindow = deferred()
  let delayedProbe = false
  const fs = nodeFileSystem({
    async readFile(path) {
      try {
        return await readFile(path)
      } catch (error) {
        if (path === destination && !delayedProbe) {
          delayedProbe = true
          reachedCollisionWindow.resolve()
          await releaseCollisionWindow.promise
        }
        throw error
      }
    },
    async link(existingPath, newPath) {
      if (newPath === destination) {
        reachedCollisionWindow.resolve()
        await releaseCollisionWindow.promise
      }
      await link(existingPath, newPath)
    },
  })
  const records = store(root, { fileSystem: fs })
  const pending = records[operation]('memory-1')
  await reachedCollisionWindow.promise
  const collision = Buffer.from('independent destination artifact')
  await writeFile(destination, collision)
  releaseCollisionWindow.resolve()

  await assert.rejects(() => pending, /already exists/i)
  assert.deepEqual(await readFile(source), sourceEnvelope)
  assert.deepEqual(await readFile(destination), collision)
}

test('forget uses a forced no-replace move when trash appears during publication', async (t) => {
  await assertMoveCollisionDoesNotOverwrite(await temporaryRoot(t), 'forget')
})

test('restore uses a forced no-replace move when a canonical record appears during publication', async (t) => {
  await assertMoveCollisionDoesNotOverwrite(await temporaryRoot(t), 'restore')
})

test('canonical and trash reads reject an embedded identifier that differs from the requested path', async (t) => {
  const root = await temporaryRoot(t)
  const records = store(root)
  const created = await records.create(input())
  const mismatched = await memoryCrypto().encrypt(serializeMemoryRecord({ ...created, id: 'other-id' }))
  await writeFile(join(root, 'records', 'memory-1.md.enc'), mismatched)

  await assert.rejects(() => records.read('memory-1'), /does not match/i)

  await writeFile(join(root, 'trash', 'records', 'memory-1.md.enc'), mismatched)
  await assert.rejects(() => records.readTrash('memory-1'), /does not match/i)
})

test('version reads reject embedded identifiers and versions that differ from the requested path', async (t) => {
  const root = await temporaryRoot(t)
  const records = store(root)
  const created = await records.create(input())
  await records.update('memory-1', { title: 'Version two' })
  const versionPath = join(root, 'versions', 'memory-1', '1.json.enc')

  await writeFile(versionPath, await memoryCrypto().encrypt(serializeMemoryRecord({ ...created, id: 'other-id' })))
  await assert.rejects(() => records.readVersion('memory-1', 1), /does not match/i)

  await writeFile(versionPath, await memoryCrypto().encrypt(serializeMemoryRecord({ ...created, version: 9 })))
  await assert.rejects(() => records.readVersion('memory-1', 1), /does not match/i)
})

test('public read failures are typed and never expose managed paths or record content', async (t) => {
  const root = await temporaryRoot(t)
  const title = 'Highly Confidential Apollo Plan'
  const fs = nodeFileSystem({
    async readFile(path) { throw new Error(`cannot read ${path}: ${title}`) },
  })

  await assert.rejects(
    () => store(root, { fileSystem: fs }).read('memory-1'),
    (error: Error & { code?: string }) => {
      assert.equal(error.name, 'RecordStoreError')
      assert.equal(error.code, 'storage-failure')
      assert.equal(error.message.includes(root), false)
      assert.equal(error.message.includes(title), false)
      return true
    },
  )
})

test('public move failures are typed and never expose source or destination paths', async (t) => {
  const root = await temporaryRoot(t)
  const records = store(root)
  await records.create(input())
  const fs = nodeFileSystem({
    async link(existingPath, newPath) { throw new Error(`link failed: ${existingPath} -> ${newPath}`) },
    async rename(oldPath, newPath) { throw new Error(`rename failed: ${oldPath} -> ${newPath}`) },
  })

  await assert.rejects(
    () => store(root, { fileSystem: fs }).forget('memory-1'),
    (error: Error & { code?: string }) => {
      assert.equal(error.name, 'RecordStoreError')
      assert.equal(error.code, 'storage-failure')
      assert.equal(error.message.includes(root), false)
      return true
    },
  )
})

test('create succeeds after publication when its staging hard-link cleanup fails', async (t) => {
  const root = await temporaryRoot(t)
  let injected = false
  const fs = nodeFileSystem({
    async unlink(path) {
      if (!injected && dirname(path) === join(root, 'records') && basename(path).startsWith('.stage-')) {
        injected = true
        throw new Error(`injected post-link cleanup failure: ${path}`)
      }
      await unlink(path)
    },
  })
  const records = store(root, { fileSystem: fs })

  const created = await records.create(input())

  assert.equal(injected, true)
  assert.deepEqual(await records.read('memory-1'), created)
  assert.equal((await readdir(join(root, 'records'))).some((name) => name.startsWith('.stage-')), true)
})

test('update continues after published version-claim cleanup fails and later updates are not wedged', async (t) => {
  const root = await temporaryRoot(t)
  const healthy = store(root)
  await healthy.create(input())
  let injected = false
  const versionDirectory = join(root, 'versions', 'memory-1')
  const fs = nodeFileSystem({
    async unlink(path) {
      if (!injected && dirname(path) === versionDirectory && basename(path).startsWith('.stage-')) {
        injected = true
        throw new Error(`injected post-claim cleanup failure: ${path}`)
      }
      await unlink(path)
    },
  })
  const records = store(root, { fileSystem: fs })

  const second = await records.update('memory-1', { title: 'Second version' })
  const third = await records.update('memory-1', { title: 'Third version' })

  assert.equal(injected, true)
  assert.equal(second.version, 2)
  assert.equal(third.version, 3)
  assert.equal((await records.read('memory-1')).title, 'Third version')
  assert.equal((await records.readVersion('memory-1', 1)).version, 1)
  assert.equal((await records.readVersion('memory-1', 2)).version, 2)
})

test('startup recovery removes a staging hard link abandoned after successful publication', async (t) => {
  const root = await temporaryRoot(t)
  let injected = false
  const fs = nodeFileSystem({
    async unlink(path) {
      if (!injected && dirname(path) === join(root, 'records') && basename(path).startsWith('.stage-')) {
        injected = true
        throw new Error('injected cleanup failure')
      }
      await unlink(path)
    },
  })
  const created = await store(root, { fileSystem: fs }).create(input())
  const namesBeforeRecovery = await readdir(join(root, 'records'))

  assert.equal(namesBeforeRecovery.includes('memory-1.md.enc'), true)
  assert.equal(namesBeforeRecovery.some((name) => name.startsWith('.stage-')), true)

  const recovered = store(root)
  await recovered.initialize()

  assert.deepEqual(await readdir(join(root, 'records')), ['memory-1.md.enc'])
  assert.deepEqual(await recovered.read('memory-1'), created)
})
