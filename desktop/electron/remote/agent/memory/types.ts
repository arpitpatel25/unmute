export const MEMORY_KINDS = [
  'note',
  'document',
  'image',
  'reference',
  'guidance',
  'template',
  'credential-ref',
] as const

export type MemoryKind = typeof MEMORY_KINDS[number]
export type MemorySensitivity = 'normal' | 'private' | 'sensitive'
export type MemorySource = 'voice' | 'selection' | 'attachment' | 'import'
export type MemoryReferenceType = 'url' | 'path' | 'external'

export interface MemoryScope {
  app?: string
  project?: string
  purpose?: string
}

export interface MemoryReference {
  type: MemoryReferenceType
  value: string
}

export interface MemoryProvenance {
  source: MemorySource
  original?: string
}

/**
 * Canonical kinds are strings so a newer writer's kind survives an older
 * reader unchanged. Consumers that need the current vocabulary must use the
 * presentation boundary instead of normalizing stored data.
 */
export interface MemoryRecord {
  id: string
  kind: string
  title: string
  content?: string
  tags: string[]
  scope?: MemoryScope
  sensitivity: MemorySensitivity
  attachments: string[]
  references: MemoryReference[]
  provenance: MemoryProvenance
  createdAt: number
  updatedAt: number
  version: number
  deletedAt?: number
}

export type CreateMemoryRecordInput = Omit<
  MemoryRecord,
  'id' | 'createdAt' | 'updatedAt' | 'version' | 'deletedAt'
>

export interface MemoryRecordPatch {
  kind?: string
  title?: string
  content?: string | null
  tags?: string[]
  scope?: MemoryScope | null
  sensitivity?: MemorySensitivity
  attachments?: string[]
  references?: MemoryReference[]
  provenance?: MemoryProvenance
}

export type PresentedMemoryRecord = Omit<MemoryRecord, 'kind'> & { kind: MemoryKind }
