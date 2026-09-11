import { test } from 'node:test'
import assert from 'node:assert/strict'

import { KeyedRemoteDispatchQueue, remoteDispatchQueueKey } from './remoteDispatchQueue'

test('a running Agent delivery does not block a task delivery', async () => {
  const queue = new KeyedRemoteDispatchQueue()
  let releaseAgent!: () => void
  const agentBlocked = new Promise<void>(resolve => { releaseAgent = resolve })
  const completed: string[] = []

  const agent = queue.enqueue('agent', async () => {
    await agentBlocked
    completed.push('agent')
  })
  const task = queue.enqueue('task:task-1', async () => {
    completed.push('task')
  })

  await task
  assert.deepEqual(completed, ['task'])
  releaseAgent()
  await agent
  assert.deepEqual(completed, ['task', 'agent'])
})

test('deliveries to the same destination remain ordered', async () => {
  const queue = new KeyedRemoteDispatchQueue()
  let releaseFirst!: () => void
  const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve })
  const completed: string[] = []

  const first = queue.enqueue('task:task-1', async () => {
    await firstBlocked
    completed.push('first')
  })
  const second = queue.enqueue('task:task-1', async () => {
    completed.push('second')
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(completed, [])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(completed, ['first', 'second'])
})

test('queue keys preserve the snapshotted destination', () => {
  assert.equal(remoteDispatchQueueKey('agent', null), 'agent')
  assert.equal(remoteDispatchQueueKey('task', 'task-1'), 'task:task-1')
  assert.equal(remoteDispatchQueueKey('task', null), 'task:router')
  assert.equal(remoteDispatchQueueKey('task', 'task-1', 'composer-token'), 'composer:composer-token')
})
