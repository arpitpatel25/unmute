import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { JsonlMemoryAudit, principalIdHash } from './audit.ts'
import type { McpPrincipal } from '../types.ts'

const roots: string[] = []

after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

const agent: McpPrincipal = {
  kind: 'unmute-agent', runId: 'run-secret', interactionId: 'interaction-secret', expiresAt: 5_000,
}

test('writes serialized content-free audit rows with only hashed principal identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unmute-memory-audit-'))
  roots.push(root)
  const audit = new JsonlMemoryAudit({ root })

  await Promise.all([
    audit.write({ principal: agent, memoryId: 'memory-1', operation: 'get', at: 1_000, outcome: 'success' }),
    audit.write({ principal: agent, memoryId: 'memory-2', operation: 'update', at: 1_001, outcome: 'failure' }),
  ])

  const lines = (await readFile(join(root, 'audit', 'access.jsonl'), 'utf8')).trim().split('\n')
  assert.equal(lines.length, 2)
  const rows = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  assert.deepEqual(rows.map(Object.keys), [
    ['principalKind', 'principalIdHash', 'memoryId', 'operation', 'at', 'outcome'],
    ['principalKind', 'principalIdHash', 'memoryId', 'operation', 'at', 'outcome'],
  ])
  assert.deepEqual(rows, [
    {
      principalKind: 'unmute-agent', principalIdHash: principalIdHash(agent), memoryId: 'memory-1',
      operation: 'get', at: 1_000, outcome: 'success',
    },
    {
      principalKind: 'unmute-agent', principalIdHash: principalIdHash(agent), memoryId: 'memory-2',
      operation: 'update', at: 1_001, outcome: 'failure',
    },
  ])
  assert.equal(lines.join('\n').includes('run-secret'), false)
  assert.equal(lines.join('\n').includes('interaction-secret'), false)
  assert.equal(lines.join('\n').includes('/'), false)
})

test('hashes each principal kind deterministically without conflating its identity fields', () => {
  const first = principalIdHash(agent)
  assert.equal(first, principalIdHash({ ...agent }))
  assert.notEqual(first, principalIdHash({ ...agent, runId: 'other-run' }))
  assert.notEqual(first, principalIdHash({ kind: 'task', taskId: 'run-secret' }))
  assert.match(first, /^[a-f0-9]{64}$/)
})
