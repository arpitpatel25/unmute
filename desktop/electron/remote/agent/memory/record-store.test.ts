import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'

import { MemoryCrypto } from './crypto.ts'
import {
  EncryptedRecordStore,
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
    scope: { app: 'Slack', project: 'Atlas', purpose: 'writing' },
    sensitivity: 'private',
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
    async rename(oldPath, newPath) { await rename(oldPath, newPath) },
    readdir: (path, options) => readdir(path, options),
    async unlink(path) { await unlink(path) },
    ...overrides,
  }
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

test('serializes deterministic metadata and Markdown in a versioned JSON payload', () => {
  const record: MemoryRecord = {
    id: 'memory-1',
    kind: 'note',
    title: 'A: title',
    content: '# Body\n\nText',
    tags: ['two', 'one'],
    sensitivity: 'normal',
    attachments: [],
    references: [],
    provenance: { source: 'import' },
    createdAt: 10,
    updatedAt: 20,
    version: 3,
  }

  assert.equal(serializeMemoryRecord(record), JSON.stringify({
    format: 'unmute-memory-record',
    serializerVersion: 1,
    document: [
      '---',
      'serializerVersion: 1',
      'id: "memory-1"',
      'kind: "note"',
      'title: "A: title"',
      'tags: ["two","one"]',
      'scope: null',
      'sensitivity: "normal"',
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
    sensitivity: 'normal',
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

test('publishes a write only after staging, fsync, close, and atomic rename', async (t) => {
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
  })

  await store(root, { fileSystem: fs }).create(input())

  assert.match(events[0], /^open:\.stage-memory-1\..+\.tmp:wx:600$/)
  assert.deepEqual(events.slice(1, 4), ['write', 'sync', 'close'])
  assert.match(events[4], /^rename:\.stage-memory-1\..+\.tmp:memory-1\.md\.enc$/)
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

  await assert.rejects(() => records.read('memory-1'), { code: 'ENOENT' })
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
  await assert.rejects(() => records.readTrash('memory-1'), { code: 'ENOENT' })
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
    /injected record write failure/,
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
    /injected record rename failure/,
  )
  assert.deepEqual(await readFile(canonicalPath), priorEnvelope)
  assert.equal((await healthy.read('memory-1')).version, 1)
  assert.deepEqual(await readdir(join(root, 'records')), ['memory-1.md.enc'])
})
