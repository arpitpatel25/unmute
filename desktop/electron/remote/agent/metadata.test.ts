import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requireAgentMetadata, resolveAgentMetadata } from './metadata.ts'

test('agent metadata refuses missing and placeholder names and workspaces', () => {
  for (const title of [undefined, '', 'New conversation', 'Untitled', 'Task', 'Fork', 'Resume session', 'unmute', 'Earlier work you are continuing from']) {
    assert.throws(() => requireAgentMetadata({ title, group: 'Unmute' }), /title/i)
  }
  for (const group of [undefined, '', 'Ungrouped', 'Workspace']) {
    assert.throws(() => requireAgentMetadata({ title: 'Repair billing migration', group }), /workspace/i)
  }
})

test('a folder basename is not inherited as a descriptive source title', () => {
  assert.equal(resolveAgentMetadata({ title: 'Repair billing migration', group: 'Unmute' },
    { find: () => ({ id: 'unmute', label: 'Unmute' }) }, { name: 'billing', cwd: '/projects/billing' }).title,
  'Repair billing migration')
  assert.throws(() => resolveAgentMetadata({ title: 'billing', group: 'Unmute', cwd: '/projects/billing' },
    { find: () => ({ id: 'unmute', label: 'Unmute' }) }), /title/i)
})

test('canonical resolution preserves source identity and title without suffixes', () => {
  const registry = { find: () => ({ id: 'canonical', label: 'Unmute' }), get: () => ({ id: 'source-id', label: 'Unmute Cloud' }) }
  assert.deepEqual(resolveAgentMetadata({ title: 'Alternate billing migration', group: 'unmute' }, registry,
    { name: 'Repair billing migration', group: 'old label', groupId: 'source-id' }),
  { title: 'Repair billing migration', group: 'Unmute Cloud', groupId: 'source-id' })
  assert.deepEqual(resolveAgentMetadata({ title: 'Repair billing migration', group: 'unmute' }, registry),
    { title: 'Repair billing migration', group: 'Unmute', groupId: 'canonical' })
  assert.throws(() => resolveAgentMetadata({ title: 'Repair billing migration', group: 'Invented' }, { find: () => undefined }), /existing workspace/i)
})
