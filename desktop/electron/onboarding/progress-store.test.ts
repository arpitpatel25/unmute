import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { OnboardingCoordinator } from './coordinator'
import { initialProgress } from './machine'
import { ProgressStore } from './progress-store'

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'unmute-onboarding-'))
  return join(directory, 'progress.json')
}

test('a saved action resumes after a new store instance', async () => {
  const path = await temporaryPath()
  const first = new ProgressStore(path)
  await first.save(initialProgress({
    action: 'system-audio',
    completed: ['privacy', 'microphone', 'accessibility', 'input-monitoring'],
  }))

  const second = new ProgressStore(path)
  assert.equal((await second.load()).action, 'system-audio')
})

test('writes are private and leave no torn JSON', async () => {
  const path = await temporaryPath()
  const store = new ProgressStore(path)
  await Promise.all([
    store.save(initialProgress({ action: 'microphone' })),
    store.save(initialProgress({ action: 'accessibility' })),
  ])

  const raw = await readFile(path, 'utf8')
  assert.doesNotThrow(() => JSON.parse(raw))
  assert.equal((await stat(path)).mode & 0o777, 0o600)
})

test('corrupt progress recovers to a safe fresh journey', async () => {
  const path = await temporaryPath()
  await writeFile(path, '{not-json', 'utf8')

  const recovered = await new ProgressStore(path).load()
  assert.equal(recovered.action, 'privacy')
  assert.deepEqual(recovered.completed, [])
})

test('legacy-shaped progress is normalized without skipping capabilities', async () => {
  const path = await temporaryPath()
  await writeFile(path, JSON.stringify({ schema: 1, action: 'notes-dictation', completed: ['privacy'] }), 'utf8')

  const recovered = await new ProgressStore(path).load()
  assert.equal(recovered.action, 'notes-dictation')
  assert.deepEqual(recovered.taskIds, {})
  assert.deepEqual(recovered.observedCaptureItemIds, [])
})

test('coordinator saves an accepted event before publishing its snapshot', async () => {
  const path = await temporaryPath()
  const store = new ProgressStore(path)
  const coordinator = new OnboardingCoordinator(store, () => 42)
  await coordinator.start()

  const snapshot = await coordinator.dispatch({ type: 'capability-satisfied', action: 'privacy' })

  assert.equal(snapshot.action, 'microphone')
  assert.equal((await new ProgressStore(path).load()).action, 'microphone')
  assert.equal((await readFile(path, 'utf8')).includes('"updatedAt":42'), true)
})

test('coordinator reset removes prior progress and returns to privacy', async () => {
  const path = await temporaryPath()
  const coordinator = new OnboardingCoordinator(new ProgressStore(path), () => 7)
  await coordinator.start()
  await coordinator.dispatch({ type: 'capability-satisfied', action: 'privacy' })

  const snapshot = await coordinator.reset()

  assert.equal(snapshot.action, 'privacy')
  assert.equal((await new ProgressStore(path).load()).action, 'privacy')
})
