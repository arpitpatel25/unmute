import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import type { MemoryRecord } from './types.ts'
import {
  MemoryIndexError,
  openSqlCipherMemoryIndex,
} from './sqlcipher-index.ts'

const MASTER_KEY = Buffer.alloc(32, 0x4d)
const WRONG_KEY = Buffer.alloc(32, 0x77)
const require = createRequire(import.meta.url)

interface NativeDatabase {
  pragma(source: string, options?: { simple?: boolean }): unknown
  prepare(source: string): {
    all(...values: unknown[]): unknown[]
    get(...values: unknown[]): unknown
    run(...values: unknown[]): { changes: number }
  }
  close(): void
}

interface NativeDatabaseConstructor {
  new(path: string, options?: { readonly?: boolean; fileMustExist?: boolean }): NativeDatabase
  prototype: NativeDatabase
}

interface ModuleInternals {
  _load(request: string, parent: unknown, isMain: boolean): unknown
}

interface KeyCopyObservation {
  copies: Buffer[]
  restore(): void
}

function nativeDatabase(): NativeDatabaseConstructor {
  return require('better-sqlite3-multiple-ciphers') as NativeDatabaseConstructor
}

function observeTemporaryKeyCopies(
  source: Uint8Array,
  wrap: (copy: Buffer) => Buffer = (copy) => copy,
): KeyCopyObservation {
  const mutableBuffer = Buffer as unknown as { from(...values: unknown[]): Buffer }
  const originalFrom = mutableBuffer.from
  const copies: Buffer[] = []
  mutableBuffer.from = function(...values) {
    const result = originalFrom.apply(Buffer, values)
    if (values[0] === source) {
      copies.push(result)
      return wrap(result)
    }
    return result
  }
  return {
    copies,
    restore() { mutableBuffer.from = originalFrom },
  }
}

function assertKeyCopyCleared(observation: KeyCopyObservation, caller: Buffer, byte: number): void {
  assert.equal(observation.copies.length, 1)
  assert.deepEqual(observation.copies[0], Buffer.alloc(caller.byteLength))
  assert.deepEqual(caller, Buffer.alloc(caller.byteLength, byte))
}

function applyKey(database: NativeDatabase, key: Buffer): void {
  database.pragma(`key = "x'${key.toString('hex')}'"`)
}

async function temporaryDatabase(t: test.TestContext): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'unmute-memory-index-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, path: join(root, 'memory.sqlite') }
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'memory-1',
    kind: 'guidance',
    title: 'Atlas launch voice',
    content: 'Use concise sentences for the quarterly launch update.',
    tags: ['atlas', 'writing'],
    scope: { app: 'Slack', project: 'Atlas', purpose: 'status update' },
    sensitivity: 'normal',
    attachments: ['attachment-1'],
    references: [{ type: 'url', value: 'https://example.com/atlas' }],
    provenance: { source: 'voice', original: 'Remember the Atlas launch voice' },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    version: 1,
    ...overrides,
  }
}

function schemaNames(database: NativeDatabase): string[] {
  return database.prepare(
    `SELECT name FROM sqlite_master
      WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
      ORDER BY name`,
  ).all().map((row) => (row as { name: string }).name)
}

test('opens a real SQLCipher database and creates the complete projection schema', async (t) => {
  const temporary = await temporaryDatabase(t)
  const index = openSqlCipherMemoryIndex({ databasePath: temporary.path, key: MASTER_KEY })

  assert.match(index.cipherVersion, /^SQLite3 Multiple Ciphers \d/)
  index.close()

  const Database = nativeDatabase()
  const encrypted = new Database(temporary.path, { readonly: true, fileMustExist: true })
  applyKey(encrypted, MASTER_KEY)
  assert.deepEqual(
    schemaNames(encrypted).filter((name) => [
      'attachments',
      'memories',
      'memory_fts',
      'memory_tags',
      'memory_versions',
    ].includes(name)),
    ['attachments', 'memories', 'memory_fts', 'memory_tags', 'memory_versions'],
  )
  const indexes = encrypted.prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'memories'
      ORDER BY name`,
  ).all().map((row) => (row as { name: string }).name)
  assert.deepEqual(indexes, [
    'memories_deleted_at_idx',
    'memories_kind_idx',
    'memories_sensitivity_idx',
    'memories_title_normalized_idx',
    'memories_updated_at_idx',
    'sqlite_autoindex_memories_1',
  ])
  encrypted.close()
})

test('clears an invalid temporary key copy without mutating the caller key', () => {
  const caller = Buffer.alloc(31, 0x31)
  const observation = observeTemporaryKeyCopies(caller)
  try {
    assert.throws(
      () => openSqlCipherMemoryIndex({ databasePath: 'unused.sqlite', key: caller }),
      (error: unknown) => error instanceof MemoryIndexError && error.code === 'invalid-key',
    )
  } finally {
    observation.restore()
  }

  assertKeyCopyCleared(observation, caller, 0x31)
})

test('clears the temporary key copy when validation aborts after copying', () => {
  const caller = Buffer.alloc(32, 0x35)
  let firstLengthRead = true
  const observation = observeTemporaryKeyCopies(caller, (copy) => new Proxy(copy, {
    get(target, property) {
      if (property === 'byteLength' && firstLengthRead) {
        firstLengthRead = false
        throw new Error('injected key validation failure')
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }))
  try {
    assert.throws(
      () => openSqlCipherMemoryIndex({ databasePath: 'unused.sqlite', key: caller }),
      /injected key validation failure/,
    )
  } finally {
    observation.restore()
  }

  assertKeyCopyCleared(observation, caller, 0x35)
})

test('clears the temporary key copy when lazy native loading fails', () => {
  const caller = Buffer.alloc(32, 0x32)
  const observation = observeTemporaryKeyCopies(caller)
  const modules = require('node:module') as ModuleInternals
  const originalLoad = modules._load
  modules._load = function(request, parent, isMain) {
    if (request === 'better-sqlite3-multiple-ciphers') throw new Error('injected native load failure')
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    assert.throws(
      () => openSqlCipherMemoryIndex({ databasePath: 'unused.sqlite', key: caller }),
      (error: unknown) => error instanceof MemoryIndexError && error.code === 'native-unavailable',
    )
  } finally {
    modules._load = originalLoad
    observation.restore()
  }

  assertKeyCopyCleared(observation, caller, 0x32)
})

test('clears the temporary key copy when the native database cannot open the path', async (t) => {
  const temporary = await temporaryDatabase(t)
  const caller = Buffer.alloc(32, 0x33)
  const observation = observeTemporaryKeyCopies(caller)
  try {
    assert.throws(
      () => openSqlCipherMemoryIndex({
        databasePath: join(temporary.root, 'missing-parent', 'memory.sqlite'),
        key: caller,
      }),
      (error: unknown) => error instanceof MemoryIndexError && error.code === 'open-failed',
    )
  } finally {
    observation.restore()
  }

  assertKeyCopyCleared(observation, caller, 0x33)
})

test('clears the temporary key copy after a normal encrypted open', async (t) => {
  const temporary = await temporaryDatabase(t)
  const caller = Buffer.alloc(32, 0x34)
  const observation = observeTemporaryKeyCopies(caller)
  let index
  try {
    index = openSqlCipherMemoryIndex({ databasePath: temporary.path, key: caller })
  } finally {
    observation.restore()
  }
  index?.close()

  assertKeyCopyCleared(observation, caller, 0x34)
})

test('fails closed before schema creation when the native cipher engine has no attestation', async (t) => {
  const temporary = await temporaryDatabase(t)
  const Database = nativeDatabase()
  const originalPragma = Database.prototype.pragma
  const originalPrepare = Database.prototype.prepare
  Database.prototype.pragma = function(source, options) {
    if (source === 'cipher_version') return undefined
    return originalPragma.call(this, source, options)
  }
  Database.prototype.prepare = function(source) {
    if (source === 'SELECT sqlite3mc_version() AS cipher_version') {
      return {
        all: () => [],
        get: () => ({ cipher_version: '' }),
        run: () => ({ changes: 0 }),
      }
    }
    return originalPrepare.call(this, source)
  }
  t.after(() => {
    Database.prototype.pragma = originalPragma
    Database.prototype.prepare = originalPrepare
  })

  assert.throws(
    () => openSqlCipherMemoryIndex({ databasePath: temporary.path, key: MASTER_KEY }),
    (error: unknown) => error instanceof MemoryIndexError && error.code === 'cipher-unavailable',
  )
  Database.prototype.pragma = originalPragma
  Database.prototype.prepare = originalPrepare

  const encrypted = new Database(temporary.path)
  applyKey(encrypted, MASTER_KEY)
  assert.ok(!schemaNames(encrypted).includes('memories'))
  encrypted.close()
})

test('the encrypted schema cannot be read without the key or with the wrong key', async (t) => {
  const temporary = await temporaryDatabase(t)
  openSqlCipherMemoryIndex({ databasePath: temporary.path, key: MASTER_KEY }).close()
  const Database = nativeDatabase()

  const unkeyed = new Database(temporary.path, { readonly: true, fileMustExist: true })
  assert.throws(() => schemaNames(unkeyed))
  unkeyed.close()

  const wronglyKeyed = new Database(temporary.path, { readonly: true, fileMustExist: true })
  applyKey(wronglyKeyed, WRONG_KEY)
  assert.throws(() => schemaNames(wronglyKeyed))
  wronglyKeyed.close()

  let failure: unknown
  try {
    openSqlCipherMemoryIndex({ databasePath: temporary.path, key: WRONG_KEY })
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof MemoryIndexError)
  assert.equal(failure.code, 'open-failed')
  assert.doesNotMatch(failure.message, /not a database|malformed|sqlite/i)
  assert.ok(!failure.message.includes(temporary.path))
  assert.ok(!failure.message.includes(basename(temporary.path)))
})

test('finds exact titles and lexical body terms while requiring explicit private access', async (t) => {
  const temporary = await temporaryDatabase(t)
  const index = openSqlCipherMemoryIndex({ databasePath: temporary.path, key: MASTER_KEY })
  t.after(() => index.close())
  index.project(record())
  index.project(record({
    id: 'memory-private',
    title: 'Private launch checklist',
    content: 'Coordinate the zephyr rehearsal with Mira.',
    sensitivity: 'private',
  }))

  const exact = index.search({ text: 'Atlas launch voice' })
  assert.deepEqual(exact.map((item) => item.id), ['memory-1'])
  assert.equal(exact[0]!.exactTitle, true)
  const lexical = index.search({ text: 'quarterly concise' })
  assert.deepEqual(lexical.map((item) => item.id), ['memory-1'])
  assert.equal(lexical[0]!.exactTitle, false)
  assert.deepEqual(index.search({ text: 'zephyr' }), [])
  assert.deepEqual(
    index.search({ text: 'zephyr', includePrivate: true }).map((item) => item.id),
    ['memory-private'],
  )
})

test('omits secret-bearing bodies and tags from every searchable and returned projection surface', async (t) => {
  const temporary = await temporaryDatabase(t)
  const index = openSqlCipherMemoryIndex({ databasePath: temporary.path, key: MASTER_KEY })
  index.project(record({
    id: 'memory-credential',
    kind: 'credential-ref',
    title: 'Production API credential',
    content: 'raw-secret-value-sk_live_123',
    tags: ['credential-tag-canary'],
    sensitivity: 'normal',
  }))
  index.project(record({
    id: 'memory-sensitive',
    kind: 'guidance',
    title: 'Private recovery answer',
    content: 'sensitive-answer-canary',
    tags: ['sensitive-tag-canary'],
    sensitivity: 'sensitive',
  }))

  assert.deepEqual(index.search({ text: 'sk_live_123' }), [])
  assert.deepEqual(index.search({ text: 'credential-tag-canary' }), [])
  const credentialHits = index.search({ text: 'Production API credential' })
  assert.deepEqual(credentialHits.map((item) => item.id), ['memory-credential'])
  assert.deepEqual(credentialHits[0]!.tags, [])
  assert.deepEqual(index.search({
    text: 'Production API credential',
    tags: ['credential-tag-canary'],
  }), [])

  assert.deepEqual(index.search({ text: 'sensitive-answer-canary', includeSensitive: true }), [])
  assert.deepEqual(index.search({ text: 'sensitive-tag-canary', includeSensitive: true }), [])
  const sensitiveHits = index.search({ text: 'Private recovery answer', includeSensitive: true })
  assert.deepEqual(sensitiveHits.map((item) => item.id), ['memory-sensitive'])
  assert.deepEqual(sensitiveHits[0]!.tags, [])
  assert.deepEqual(index.search({
    text: 'Private recovery answer',
    tags: ['sensitive-tag-canary'],
    includeSensitive: true,
  }), [])
  index.close()

  const Database = nativeDatabase()
  const encrypted = new Database(temporary.path, { readonly: true, fileMustExist: true })
  applyKey(encrypted, MASTER_KEY)
  assert.deepEqual(
    encrypted.prepare(
      `SELECT memory_id, body, tags FROM memory_fts
        WHERE memory_id IN ('memory-credential', 'memory-sensitive')
        ORDER BY memory_id`,
    ).all(),
    [
      { memory_id: 'memory-credential', body: '', tags: '' },
      { memory_id: 'memory-sensitive', body: '', tags: '' },
    ],
  )
  assert.deepEqual(encrypted.prepare(
    `SELECT memory_id, tag FROM memory_tags
      WHERE memory_id IN ('memory-credential', 'memory-sensitive')`,
  ).all(), [])
  encrypted.close()
})

test('soft delete and restore update which projected records are searchable', async (t) => {
  const temporary = await temporaryDatabase(t)
  const index = openSqlCipherMemoryIndex({ databasePath: temporary.path, key: MASTER_KEY })
  t.after(() => index.close())
  index.project(record())

  assert.equal(index.search({ text: 'quarterly' }).length, 1)
  index.setDeleted('memory-1', 1_700_000_001_000)
  assert.equal(index.search({ text: 'quarterly' }).length, 0)
  index.setDeleted('memory-1', null)
  assert.equal(index.search({ text: 'quarterly' }).length, 1)
})

test('rebuild replaces stale projection rows with an equivalent index', async (t) => {
  const temporary = await temporaryDatabase(t)
  const index = openSqlCipherMemoryIndex({ databasePath: temporary.path, key: MASTER_KEY })
  t.after(() => index.close())
  const records = [
    record(),
    record({ id: 'memory-2', title: 'Atlas release notes', content: 'Beta release evidence.' }),
  ]
  index.project(record({ id: 'stale', title: 'Stale document', content: 'obsolete-marker' }))
  index.rebuild(records)
  const first = index.search({ text: 'Atlas' })

  index.rebuild(records)
  assert.deepEqual(index.search({ text: 'Atlas' }), first)
  assert.deepEqual(index.search({ text: 'obsolete-marker' }), [])
})

test('explicit corruption recovery quarantines only the projection and creates a fresh encrypted index', async (t) => {
  const temporary = await temporaryDatabase(t)
  const canonicalPath = join(temporary.root, 'records', 'memory-1.md.enc')
  await mkdir(join(temporary.root, 'records'))
  await writeFile(canonicalPath, Buffer.from('canonical-encrypted-record'))
  const corruption = Buffer.from('not a sqlite database')
  await writeFile(temporary.path, corruption)

  const index = openSqlCipherMemoryIndex({
    databasePath: temporary.path,
    key: MASTER_KEY,
    recoverCorruption: true,
  })
  assert.ok(index.cipherVersion.length > 0)
  assert.deepEqual(index.search({ text: 'anything' }), [])
  index.close()

  assert.deepEqual(await readFile(canonicalPath), Buffer.from('canonical-encrypted-record'))
  const quarantined = (await readdir(temporary.root)).filter((name) => name.startsWith('memory.sqlite.corrupt-'))
  assert.equal(quarantined.length, 1)
  assert.deepEqual(await readFile(join(temporary.root, quarantined[0]!)), corruption)

  const Database = nativeDatabase()
  const replacement = new Database(temporary.path, { readonly: true, fileMustExist: true })
  assert.throws(() => schemaNames(replacement))
  applyKey(replacement, MASTER_KEY)
  assert.ok(schemaNames(replacement).includes('memories'))
  replacement.close()
})
