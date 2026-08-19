import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, renameSync } from 'node:fs'
import { createRequire } from 'node:module'

import type {
  MemoryIndex,
  MemoryIndexSearchHit,
  MemoryIndexSearchQuery,
} from './index.ts'
import type { MemoryRecord, MemoryScope, MemorySensitivity } from './types.ts'

const require = createRequire(import.meta.url)
const MASTER_KEY_BYTES = 32
const DEFAULT_RESULT_LIMIT = 20
const MAX_RESULT_LIMIT = 100
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    title_normalized TEXT NOT NULL,
    sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'private', 'sensitive')),
    scope_app TEXT,
    scope_project TEXT,
    scope_purpose TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL,
    deleted_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS memories_title_normalized_idx ON memories(title_normalized);
  CREATE INDEX IF NOT EXISTS memories_updated_at_idx ON memories(updated_at DESC);
  CREATE INDEX IF NOT EXISTS memories_deleted_at_idx ON memories(deleted_at);
  CREATE INDEX IF NOT EXISTS memories_kind_idx ON memories(kind);
  CREATE INDEX IF NOT EXISTS memories_sensitivity_idx ON memories(sensitivity);

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    memory_id UNINDEXED,
    title,
    body,
    tags,
    extracted_text,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE TABLE IF NOT EXISTS memory_tags (
    memory_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    tag_normalized TEXT NOT NULL,
    PRIMARY KEY (memory_id, tag_normalized),
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS memory_tags_normalized_idx ON memory_tags(tag_normalized, memory_id);

  CREATE TABLE IF NOT EXISTS attachments (
    handle TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    mime_type TEXT,
    content_hash TEXT,
    extraction_status TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY (handle, memory_id),
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS attachments_memory_id_idx ON attachments(memory_id);

  CREATE TABLE IF NOT EXISTS memory_versions (
    memory_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    snapshot_path TEXT NOT NULL,
    PRIMARY KEY (memory_id, version),
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS memory_versions_memory_id_idx ON memory_versions(memory_id, version DESC);
`

interface NativeRunResult {
  changes: number
}

interface NativeStatement {
  run(...values: unknown[]): NativeRunResult
  get(...values: unknown[]): unknown
  all(...values: unknown[]): unknown[]
}

interface NativeDatabase {
  readonly inTransaction: boolean
  pragma(source: string, options?: { simple?: boolean }): unknown
  prepare(source: string): NativeStatement
  exec(source: string): NativeDatabase
  transaction<T extends (...values: never[]) => unknown>(operation: T): T & { immediate: T }
  close(): void
}

interface NativeDatabaseConstructor {
  new(path: string): NativeDatabase
}

interface NativeError extends Error {
  code?: string
}

class CipherUnavailableError extends Error {}

export type MemoryIndexErrorCode =
  | 'invalid-key'
  | 'invalid-query'
  | 'not-found'
  | 'native-unavailable'
  | 'cipher-unavailable'
  | 'open-failed'
  | 'operation-failed'

export class MemoryIndexError extends Error {
  constructor(readonly code: MemoryIndexErrorCode, message: string) {
    super(message)
    this.name = 'MemoryIndexError'
  }
}

export interface OpenSqlCipherMemoryIndexOptions {
  databasePath: string
  key: Uint8Array
  /**
   * Opt-in only: SQLCipher cannot distinguish corruption from a wrong key.
   * Callers must establish the key provenance before allowing quarantine.
   */
  recoverCorruption?: boolean
}

function loadNativeDatabase(): NativeDatabaseConstructor {
  try {
    return require('better-sqlite3-multiple-ciphers') as NativeDatabaseConstructor
  } catch {
    throw new MemoryIndexError('native-unavailable', 'Encrypted memory index is unavailable')
  }
}

function isNativeCorruption(error: unknown): boolean {
  const code = (error as NativeError | undefined)?.code
  return code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB'
}

function closeQuietly(database: NativeDatabase | null): void {
  try { database?.close() } catch { /* opening failure remains authoritative */ }
}

function initializeDatabase(
  Database: NativeDatabaseConstructor,
  databasePath: string,
  key: Buffer,
): { database: NativeDatabase; cipherVersion: string } {
  let database: NativeDatabase | null = null
  try {
    database = new Database(databasePath)
    // This must remain the first statement after the native open.
    database.pragma(`key = "x'${key.toString('hex')}'"`)
    const pragmaVersion = database.pragma('cipher_version', { simple: true })
    // SQLite3 Multiple Ciphers is SQLCipher-compatible but exposes its build
    // version through sqlite3mc_version() rather than SQLCipher's pragma.
    const compatibilityVersion = database.prepare(
      'SELECT sqlite3mc_version() AS cipher_version',
    ).get() as { cipher_version?: unknown } | undefined
    const reportedVersion = typeof pragmaVersion === 'string' && pragmaVersion.trim().length > 0
      ? pragmaVersion
      : compatibilityVersion?.cipher_version
    if (typeof reportedVersion !== 'string' || reportedVersion.trim().length === 0) {
      throw new CipherUnavailableError()
    }

    // Force SQLCipher to authenticate an existing file before touching schema.
    database.prepare('SELECT count(*) AS count FROM sqlite_schema').get()
    database.pragma('foreign_keys = ON')
    database.exec(SCHEMA)
    chmodSync(databasePath, 0o600)
    return { database, cipherVersion: reportedVersion }
  } catch (error) {
    closeQuietly(database)
    throw error
  }
}

function quarantineProjection(databasePath: string): void {
  const suffix = `.corrupt-${Date.now()}-${randomUUID()}`
  renameSync(databasePath, `${databasePath}${suffix}`)
  for (const companion of ['-wal', '-shm']) {
    const companionPath = `${databasePath}${companion}`
    if (existsSync(companionPath)) renameSync(companionPath, `${companionPath}${suffix}`)
  }
}

function normalizeSearchable(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}

function ftsExpression(value: string): string | null {
  const terms = normalizeSearchable(value).match(/[\p{L}\p{N}_]+/gu)
  if (!terms?.length) return null
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ')
}

function requireIdentifier(value: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new MemoryIndexError('operation-failed', 'Memory index operation failed')
  }
}

function assertRecord(record: MemoryRecord): void {
  requireIdentifier(record.id)
  if (!record.title.trim() || !record.kind.trim()) {
    throw new MemoryIndexError('operation-failed', 'Memory index operation failed')
  }
  if (!['normal', 'private', 'sensitive'].includes(record.sensitivity)) {
    throw new MemoryIndexError('operation-failed', 'Memory index operation failed')
  }
}

function operationFailure<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof MemoryIndexError) throw error
    throw new MemoryIndexError('operation-failed', 'Memory index operation failed')
  }
}

interface SearchRow {
  id: string
  kind: string
  title: string
  sensitivity: MemorySensitivity
  scope_app: string | null
  scope_project: string | null
  scope_purpose: string | null
  updated_at: number
  exact_title: number
  lexical_rank: number
}

class SqlCipherMemoryIndex implements MemoryIndex {
  private closed = false

  constructor(
    private readonly database: NativeDatabase,
    readonly cipherVersion: string,
  ) {}

  project(record: MemoryRecord): void {
    operationFailure(() => this.write(() => this.projectRecord(record)))
  }

  setDeleted(id: string, deletedAt: number | null): void {
    operationFailure(() => this.write(() => {
      requireIdentifier(id)
      if (deletedAt !== null && (!Number.isSafeInteger(deletedAt) || deletedAt < 0)) {
        throw new MemoryIndexError('operation-failed', 'Memory index operation failed')
      }
      const result = this.database.prepare(
        'UPDATE memories SET deleted_at = ? WHERE id = ?',
      ).run(deletedAt, id)
      if (result.changes === 0) throw new MemoryIndexError('not-found', 'Memory index record was not found')
    }))
  }

  remove(id: string): void {
    operationFailure(() => this.write(() => {
      requireIdentifier(id)
      this.database.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(id)
      this.database.prepare('DELETE FROM memories WHERE id = ?').run(id)
    }))
  }

  search(query: MemoryIndexSearchQuery): MemoryIndexSearchHit[] {
    return operationFailure(() => {
      this.requireOpen()
      const normalizedText = normalizeSearchable(query.text)
      if (!normalizedText) throw new MemoryIndexError('invalid-query', 'Memory index query is invalid')
      const expression = ftsExpression(query.text)
      const limit = query.limit ?? DEFAULT_RESULT_LIMIT
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULT_LIMIT) {
        throw new MemoryIndexError('invalid-query', 'Memory index query is invalid')
      }

      const where = ['m.deleted_at IS NULL', `m.sensitivity IN (${[
        'normal',
        ...(query.includePrivate ? ['private'] : []),
        ...(query.includeSensitive ? ['sensitive'] : []),
      ].map(() => '?').join(', ')})`]
      const values: unknown[] = ['normal']
      if (query.includePrivate) values.push('private')
      if (query.includeSensitive) values.push('sensitive')

      if (query.kinds?.length) {
        where.push(`m.kind IN (${query.kinds.map(() => '?').join(', ')})`)
        values.push(...query.kinds)
      }
      for (const tag of query.tags ?? []) {
        const normalized = normalizeSearchable(tag)
        if (!normalized) throw new MemoryIndexError('invalid-query', 'Memory index query is invalid')
        where.push(`EXISTS (
          SELECT 1 FROM memory_tags mt
          WHERE mt.memory_id = m.id AND mt.tag_normalized = ?
        )`)
        values.push(normalized)
      }
      this.addScopeFilter(where, values, 'scope_app', query.scope?.app)
      this.addScopeFilter(where, values, 'scope_project', query.scope?.project)
      this.addScopeFilter(where, values, 'scope_purpose', query.scope?.purpose)
      if (!expression) return []
      const rows = this.database.prepare(`
        SELECT
          m.id,
          m.kind,
          m.title,
          m.sensitivity,
          m.scope_app,
          m.scope_project,
          m.scope_purpose,
          m.updated_at,
          CASE WHEN m.title_normalized = ? THEN 1 ELSE 0 END AS exact_title,
          bm25(memory_fts) AS lexical_rank
        FROM memory_fts
        JOIN memories m ON m.id = memory_fts.memory_id
        WHERE memory_fts MATCH ? AND ${where.join(' AND ')}
        ORDER BY exact_title DESC, lexical_rank ASC, m.updated_at DESC, m.id ASC
        LIMIT ?
      `).all(normalizedText, expression, ...values, limit) as SearchRow[]

      const tags = this.database.prepare(
        'SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag_normalized',
      )
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        tags: tags.all(row.id).map((tag) => (tag as { tag: string }).tag),
        scope: this.rowScope(row),
        sensitivity: row.sensitivity,
        updatedAt: row.updated_at,
        exactTitle: row.exact_title === 1,
        lexicalRank: row.lexical_rank,
      }))
    })
  }

  rebuild(records: readonly MemoryRecord[]): void {
    operationFailure(() => this.write(() => {
      this.database.exec(`
        DELETE FROM memory_fts;
        DELETE FROM attachments;
        DELETE FROM memory_tags;
        DELETE FROM memory_versions;
        DELETE FROM memories;
      `)
      for (const record of records) this.projectRecord(record)
    }))
  }

  runInTransaction<T>(operation: () => T): T {
    return operationFailure(() => this.write(operation))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.database.close()
    } catch {
      throw new MemoryIndexError('operation-failed', 'Memory index operation failed')
    }
  }

  private projectRecord(record: MemoryRecord): void {
    this.requireOpen()
    assertRecord(record)
    const scope = record.scope ?? {}
    this.database.prepare(`
      INSERT INTO memories (
        id, kind, title, title_normalized, sensitivity,
        scope_app, scope_project, scope_purpose,
        created_at, updated_at, version, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        title = excluded.title,
        title_normalized = excluded.title_normalized,
        sensitivity = excluded.sensitivity,
        scope_app = excluded.scope_app,
        scope_project = excluded.scope_project,
        scope_purpose = excluded.scope_purpose,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        version = excluded.version,
        deleted_at = excluded.deleted_at
    `).run(
      record.id,
      record.kind,
      record.title,
      normalizeSearchable(record.title),
      record.sensitivity,
      scope.app ?? null,
      scope.project ?? null,
      scope.purpose ?? null,
      record.createdAt,
      record.updatedAt,
      record.version,
      record.deletedAt ?? null,
    )

    this.database.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(record.id)
    this.database.prepare('DELETE FROM memory_tags WHERE memory_id = ?').run(record.id)
    this.database.prepare('DELETE FROM attachments WHERE memory_id = ?').run(record.id)
    const secretBearing = record.sensitivity === 'sensitive' || record.kind === 'credential-ref'
    const body = secretBearing ? '' : record.content ?? ''
    const searchableTags = secretBearing ? '' : record.tags.join(' ')
    this.database.prepare(`
      INSERT INTO memory_fts (memory_id, title, body, tags, extracted_text)
      VALUES (?, ?, ?, ?, '')
    `).run(record.id, record.title, body, searchableTags)

    const insertTag = this.database.prepare(
      'INSERT OR REPLACE INTO memory_tags (memory_id, tag, tag_normalized) VALUES (?, ?, ?)',
    )
    for (const tag of secretBearing ? [] : record.tags) {
      const normalized = normalizeSearchable(tag)
      if (normalized) insertTag.run(record.id, tag, normalized)
    }

    const insertAttachment = this.database.prepare(`
      INSERT INTO attachments (handle, memory_id, extraction_status)
      VALUES (?, ?, 'pending')
    `)
    for (const attachment of new Set(record.attachments)) {
      insertAttachment.run(attachment, record.id)
    }
  }

  private write<T>(operation: () => T): T {
    this.requireOpen()
    if (this.database.inTransaction) return operation()
    return this.database.transaction(operation).immediate()
  }

  private requireOpen(): void {
    if (this.closed) throw new MemoryIndexError('operation-failed', 'Memory index operation failed')
  }

  private addScopeFilter(
    where: string[],
    values: unknown[],
    column: 'scope_app' | 'scope_project' | 'scope_purpose',
    value: string | undefined,
  ): void {
    if (value === undefined) return
    if (!value.trim()) throw new MemoryIndexError('invalid-query', 'Memory index query is invalid')
    where.push(`m.${column} = ? COLLATE NOCASE`)
    values.push(value)
  }

  private rowScope(row: SearchRow): MemoryScope | undefined {
    const scope: MemoryScope = {}
    if (row.scope_app !== null) scope.app = row.scope_app
    if (row.scope_project !== null) scope.project = row.scope_project
    if (row.scope_purpose !== null) scope.purpose = row.scope_purpose
    return Object.keys(scope).length ? scope : undefined
  }
}

export function openSqlCipherMemoryIndex(
  options: OpenSqlCipherMemoryIndexOptions,
): MemoryIndex {
  const keyCopy = Buffer.from(options.key)
  try {
    if (keyCopy.byteLength !== MASTER_KEY_BYTES) {
      throw new MemoryIndexError('invalid-key', 'Memory index key must be 32 bytes')
    }
    const Database = loadNativeDatabase()
    const existed = existsSync(options.databasePath)
    try {
      const opened = initializeDatabase(Database, options.databasePath, keyCopy)
      return new SqlCipherMemoryIndex(opened.database, opened.cipherVersion)
    } catch (error) {
      if (error instanceof MemoryIndexError) throw error
      if (error instanceof CipherUnavailableError) {
        throw new MemoryIndexError('cipher-unavailable', 'SQLCipher support is unavailable')
      }
      if (options.recoverCorruption && existed && isNativeCorruption(error)) {
        try {
          quarantineProjection(options.databasePath)
          const opened = initializeDatabase(Database, options.databasePath, keyCopy)
          return new SqlCipherMemoryIndex(opened.database, opened.cipherVersion)
        } catch {
          throw new MemoryIndexError('open-failed', 'Encrypted memory index could not be opened')
        }
      }
      throw new MemoryIndexError('open-failed', 'Encrypted memory index could not be opened')
    }
  } finally {
    keyCopy.fill(0)
  }
}
