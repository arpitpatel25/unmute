export const MEMORY_KINDS = [
  'note',
  'document',
  'image',
  'reference',
  'guidance',
  'template',
  'credential-ref',
  // A group is a record whose whole substance is its links: the description of
  // why these belong together, plus the ordered membership. Grouping is done
  // this way rather than with folders because a record belongs in more than one
  // place — an email is a contact AND a project member — and a container forces
  // a single parent.
  'group',
] as const

export type MemoryKind = typeof MEMORY_KINDS[number]
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
  /**
   * What this record holds and when it is useful, written for a reader who has
   * never seen it. NOT an excerpt: search returns summaries rather than bodies,
   * so this is what the Agent decides on without opening anything.
   *
   * Optional on the type because records written before it existed have none;
   * required by the store tool, because a record without one is undecidable.
   */
  summary?: string
  content?: string
  tags: string[]
  /**
   * Ordered pointers to other records. ORDER IS LOAD-BEARING: a workflow's
   * steps are meaningless shuffled, so this is a list and never a set.
   */
  links: string[]
  scope?: MemoryScope
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
  summary?: string | null
  content?: string | null
  tags?: string[]
  links?: string[]
  scope?: MemoryScope | null
  attachments?: string[]
  references?: MemoryReference[]
  provenance?: MemoryProvenance
}

export type PresentedMemoryRecord = Omit<MemoryRecord, 'kind'> & { kind: MemoryKind }
