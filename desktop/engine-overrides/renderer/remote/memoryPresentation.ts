export type MemorySensitivity = 'normal' | 'private' | 'sensitive'

export interface MemoryPresentationRecord {
  id: string
  kind: string
  title: string
  tags: string[]
  scope?: { app?: string; project?: string; purpose?: string }
  sensitivity: MemorySensitivity
  provenance?: { source: string }
  attachmentCount?: number
  updatedAt: number
  version?: number
  deletedAt?: number
}

const KIND_LABELS: Record<string, string> = {
  note: 'Note',
  document: 'Document',
  image: 'Image',
  reference: 'Reference',
  guidance: 'Guidance',
  template: 'Template',
  'credential-ref': 'Credential reference',
}

const SOURCE_LABELS: Record<string, string> = {
  voice: 'Voice',
  selection: 'Selection',
  attachment: 'Attachment',
  import: 'Import',
}

export function memoryKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? 'Note'
}

export function memorySourceLabel(source?: string): string {
  if (!source) return 'Unknown source'
  return SOURCE_LABELS[source] ?? source.replace(/(^|[-_])([a-z])/g, (_match, lead, letter) => `${lead ? ' ' : ''}${letter.toUpperCase()}`)
}

export function memoryScopeChips(scope?: MemoryPresentationRecord['scope']): string[] {
  if (!scope) return ['All contexts']
  const chips = [scope.app, scope.project, scope.purpose].filter((value): value is string => !!value?.trim())
  return chips.length ? chips : ['All contexts']
}

export function memorySensitivityLabel(sensitivity: MemorySensitivity): string {
  if (sensitivity === 'sensitive') return 'Sensitive'
  if (sensitivity === 'private') return 'Private'
  return 'Normal'
}

export function memoryVersionLabel(version = 1): string {
  return `${version} ${version === 1 ? 'version' : 'versions'}`
}

export function memoryAttachmentLabel(count = 0): string {
  return count === 1 ? '1 attachment' : `${count} attachments`
}

export function memoryAction(record: Pick<MemoryPresentationRecord, 'deletedAt'>): 'forget' | 'restore' {
  return record.deletedAt === undefined ? 'forget' : 'restore'
}

export function filterMemories<T extends MemoryPresentationRecord>(records: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...records]
  return records.filter((record) => [
    record.title,
    memoryKindLabel(record.kind),
    memorySensitivityLabel(record.sensitivity),
    memorySourceLabel(record.provenance?.source),
    ...record.tags,
    ...memoryScopeChips(record.scope),
    record.deletedAt === undefined ? '' : 'trash',
  ].some((value) => value.toLocaleLowerCase().includes(needle)))
}

export function sensitiveContentConcealed(
  record: Pick<MemoryPresentationRecord, 'sensitivity'>,
  explicitlyRevealed: boolean,
): boolean {
  return record.sensitivity === 'sensitive' && !explicitlyRevealed
}
