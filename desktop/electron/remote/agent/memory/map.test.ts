import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMemoryMap, listGroupMembers, listUngrouped } from './map'
import type { MemoryRecord } from './types'

function record(partial: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    kind: 'note',
    title: partial.id,
    tags: [],
    links: [],
    attachments: [],
    references: [],
    provenance: { source: 'voice' },
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    ...partial,
  }
}

const group = (id: string, links: string[], extra: Partial<MemoryRecord> = {}) =>
  record({ id, kind: 'group', title: id, links, ...extra })

test('an empty store is reported as empty rather than as nothing to say', () => {
  const map = buildMemoryMap([])
  assert.deepEqual(map, { total: 0, groups: [], groupsOmitted: 0, ungrouped: 0 })
})

test('a record linked from two groups is counted by both and is not ungrouped', () => {
  const map = buildMemoryMap([
    record({ id: 'hooks' }),
    group('meta', ['hooks']),
    group('styles', ['hooks']),
  ])

  assert.equal(map.total, 3)
  assert.equal(map.ungrouped, 0)
  assert.deepEqual(map.groups.map((entry) => [entry.id, entry.memberCount]), [
    ['meta', 1],
    ['styles', 1],
  ])
})

test('groups are ordered by size so a truncated map keeps the likeliest answers', () => {
  const map = buildMemoryMap([
    record({ id: 'a' }), record({ id: 'b' }), record({ id: 'c' }),
    group('small', ['a']),
    group('large', ['a', 'b', 'c']),
  ])

  assert.deepEqual(map.groups.map((entry) => entry.id), ['large', 'small'])
})

test('a link to a forgotten record is not counted and does not resurrect it', () => {
  const records = [
    record({ id: 'kept' }),
    record({ id: 'gone', deletedAt: 99 }),
    group('project', ['kept', 'gone']),
  ]

  assert.equal(buildMemoryMap(records).groups[0]?.memberCount, 1)
  assert.deepEqual(listGroupMembers(records, 'project').map((entry) => entry.id), ['kept'])
})

test('members come back in the order the group lists them, not the order they were stored', () => {
  const records = [
    record({ id: 'third' }), record({ id: 'first' }), record({ id: 'second' }),
    group('workflow', ['first', 'second', 'third']),
  ]

  assert.deepEqual(
    listGroupMembers(records, 'workflow').map((entry) => entry.id),
    ['first', 'second', 'third'],
  )
})

test('a deleted group is not on the map and lists no members', () => {
  const records = [record({ id: 'kept' }), group('old', ['kept'], { deletedAt: 5 })]

  assert.deepEqual(buildMemoryMap(records).groups, [])
  assert.deepEqual(listGroupMembers(records, 'old'), [])
  // Its former member is loose again rather than stranded inside a dead group.
  assert.equal(buildMemoryMap(records).ungrouped, 1)
})

test('summaries travel with the listing so it can be decided on without opening anything', () => {
  const records = [
    record({ id: 'email', title: 'Rishi Patidar', summary: 'Personal email, used for invoices.' }),
    group('people', ['email'], { summary: 'Contacts and who is on what.' }),
  ]

  assert.equal(buildMemoryMap(records).groups[0]?.summary, 'Contacts and who is on what.')
  assert.equal(listGroupMembers(records, 'people')[0]?.summary, 'Personal email, used for invoices.')
})

test('a group is never reported as ungrouped, and loose records are', () => {
  const records = [record({ id: 'loose' }), record({ id: 'held' }), group('g', ['held'])]

  assert.equal(buildMemoryMap(records).ungrouped, 1)
  assert.deepEqual(listUngrouped(records).map((entry) => entry.id), ['loose'])
})

test('asking a non-group for its members is empty, not an error', () => {
  const records = [record({ id: 'note' })]

  assert.deepEqual(listGroupMembers(records, 'note'), [])
  assert.deepEqual(listGroupMembers(records, 'missing'), [])
})
