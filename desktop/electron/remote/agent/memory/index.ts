import type { MemoryRecord, MemoryScope } from './types.ts'

export interface MemoryIndexSearchQuery {
  text: string
  kinds?: readonly string[]
  tags?: readonly string[]
  scope?: MemoryScope
  limit?: number
}

export interface MemoryIndexSearchHit {
  id: string
  kind: string
  title: string
  tags: string[]
  scope?: MemoryScope
  updatedAt: number
  exactTitle: boolean
  lexicalRank: number
}

/** Disposable, encrypted search projection over canonical Memory records. */
export interface MemoryIndex {
  readonly cipherVersion: string
  project(record: MemoryRecord): void
  setDeleted(id: string, deletedAt: number | null): void
  remove(id: string): void
  search(query: MemoryIndexSearchQuery): MemoryIndexSearchHit[]
  rebuild(records: readonly MemoryRecord[]): void
  runInTransaction<T>(operation: () => T): T
  close(): void
}
