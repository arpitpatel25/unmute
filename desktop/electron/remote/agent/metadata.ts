export interface AgentMetadata { title: string; group: string }
export interface CanonicalAgentMetadata extends AgentMetadata { groupId: string }
import { basename } from 'node:path'

export interface MetadataSource { name?: string; intent?: string; group?: string; groupId?: string; cwd?: string }
export interface WorkspaceRegistry {
  find(label: string): { id: string; label: string } | undefined
  get?(id: string): { id: string; label: string } | undefined
}

export function isDescriptiveTitle(value: unknown, cwd?: string): value is string {
  if (typeof value !== 'string') return false
  const title = value.trim()
  return title.length >= 3 && title.length <= 160 && /[\p{L}\p{N}]/u.test(title)
    && title.toLowerCase() !== 'unmute'
    && (!cwd || title.toLowerCase() !== basename(cwd).toLowerCase())
    && !/^(earlier work you are|what the user is asking for now|exact references from that work)/i.test(title)
    && !/^(?:(?:new|untitled|resumed?|forked?|continued?|agent)\s+)?(?:conversation|session|task|chat|branch|fork|resume|untitled|new)(?:\s*\d+)?$/i.test(title)
}

export function requireAgentMetadata(input: { title?: unknown; group?: unknown }): AgentMetadata {
  if (!isDescriptiveTitle(input.title)) throw new Error('A descriptive conversation title is required')
  return { title: input.title.trim(), group: requireWorkspaceLabel(input.group) }
}

export function requireWorkspaceLabel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 32
    || /^(ungrouped|workspace|none|default|unknown)$/i.test(value.trim())) {
    throw new Error('An existing workspace label is required')
  }
  return value.trim()
}

export function resolveAgentMetadata(input: { title?: unknown; group?: unknown; cwd?: string }, registry: WorkspaceRegistry | null | undefined,
  source?: MetadataSource): CanonicalAgentMetadata {
  const metadata = requireAgentMetadata(input)
  if (!isDescriptiveTitle(metadata.title, input.cwd ?? source?.cwd)) throw new Error('A descriptive title is required, not a folder basename')
  const workspace = source?.groupId && registry?.get?.(source.groupId)
    || source?.group && registry?.find(source.group)
    || registry?.find(metadata.group)
  if (!workspace) throw new Error('Choose an existing workspace from workspaces_list')
  return { title: isDescriptiveTitle(source?.name, source?.cwd) ? source.name.trim() : metadata.title,
    group: workspace.label, groupId: workspace.id }
}
