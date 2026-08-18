import type { MemoryRecord } from './types.ts'

/**
 * The map: what the store contains, coarsely, so the Agent can navigate rather
 * than guess at query words.
 *
 * WHY THIS EXISTS. Retrieval used to be a single gamble — search for words and
 * hope they match how the record happened to be phrased. When they didn't, an
 * empty result was indistinguishable from an empty store, and the Agent once
 * answered "your memory is empty — nothing stored for anyone else" with a
 * record sitting on disk. A map read before searching makes those two states
 * different.
 *
 * DERIVED, NEVER AUTHORED. It is computed from the records every time it is
 * asked for, exactly as the search index is. A hand-maintained map would drift,
 * and a drifted map is worse than none because it will be believed.
 */

/** Groups beyond this are summarised as a count: the map must fit in a prompt. */
export const MAX_MAPPED_GROUPS = 50
/** Members listed per group when a group is opened. */
export const MAX_GROUP_MEMBERS = 200

export interface MemoryMapGroup {
  id: string
  title: string
  summary?: string
  /** Members that still exist. A link to a forgotten record is not counted. */
  memberCount: number
}

export interface MemoryMap {
  total: number
  groups: MemoryMapGroup[]
  /** Groups omitted because the map is capped; zero in the ordinary case. */
  groupsOmitted: number
  /** Live records no group links to — the things still to be filed. */
  ungrouped: number
}

export interface MemoryMapEntry {
  id: string
  title: string
  kind: string
  summary?: string
}

function live(records: readonly MemoryRecord[]): MemoryRecord[] {
  return records.filter((record) => record.deletedAt === undefined)
}

/**
 * A group is a record of kind `group`; membership is its links. Deliberately
 * NOT a folder: a record can be linked from several groups at once, which is
 * the case a container cannot express — an email that is both a contact and a
 * member of a project.
 */
export function buildMemoryMap(records: readonly MemoryRecord[]): MemoryMap {
  const present = live(records)
  const byId = new Map(present.map((record) => [record.id, record]))
  const groups = present.filter((record) => record.kind === 'group')
  const linked = new Set<string>()

  const mapped: MemoryMapGroup[] = groups.map((group) => {
    let memberCount = 0
    for (const id of group.links) {
      if (!byId.has(id)) continue
      linked.add(id)
      memberCount += 1
    }
    return {
      id: group.id,
      title: group.title,
      ...(group.summary === undefined ? {} : { summary: group.summary }),
      memberCount,
    }
  })

  // Largest first: the map is read top-down under a cap, so the groups most
  // likely to hold the answer must survive the truncation.
  mapped.sort((left, right) => (
    right.memberCount - left.memberCount || left.title.localeCompare(right.title)
  ))

  const ungrouped = present.filter((record) => (
    record.kind !== 'group' && !linked.has(record.id)
  )).length

  return {
    total: present.length,
    groups: mapped.slice(0, MAX_MAPPED_GROUPS),
    groupsOmitted: Math.max(0, mapped.length - MAX_MAPPED_GROUPS),
    ungrouped,
  }
}

/**
 * The members of one group, in the order the group lists them. Order is
 * preserved because a group may be a workflow, and a workflow's steps mean
 * nothing shuffled.
 *
 * Links to records that no longer exist are dropped rather than reported: a
 * forgotten member is not an error at the group, and a dangling id in a listing
 * is something the Agent would be tempted to chase.
 */
export function listGroupMembers(
  records: readonly MemoryRecord[],
  groupId: string,
): MemoryMapEntry[] {
  const present = live(records)
  const group = present.find((record) => record.id === groupId && record.kind === 'group')
  if (!group) return []
  const byId = new Map(present.map((record) => [record.id, record]))
  const members: MemoryMapEntry[] = []
  for (const id of group.links) {
    const record = byId.get(id)
    if (!record) continue
    members.push({
      id: record.id,
      title: record.title,
      kind: record.kind,
      ...(record.summary === undefined ? {} : { summary: record.summary }),
    })
    if (members.length >= MAX_GROUP_MEMBERS) break
  }
  return members
}

/** Live records no group links to. The answer to "what have you not filed?" */
export function listUngrouped(records: readonly MemoryRecord[]): MemoryMapEntry[] {
  const present = live(records)
  const linked = new Set<string>()
  for (const record of present) {
    if (record.kind !== 'group') continue
    for (const id of record.links) linked.add(id)
  }
  return present
    .filter((record) => record.kind !== 'group' && !linked.has(record.id))
    .slice(0, MAX_GROUP_MEMBERS)
    .map((record) => ({
      id: record.id,
      title: record.title,
      kind: record.kind,
      ...(record.summary === undefined ? {} : { summary: record.summary }),
    }))
}
