import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { dirname } from 'node:path'

import { ACTION_ORDER } from './chapters'
import { initialProgress } from './machine'
import type { ActionId, OnboardingProgress, ProviderId } from './types'

function isActionId(value: unknown): value is ActionId {
  return typeof value === 'string' && ACTION_ORDER.includes(value as ActionId)
}

function isProvider(value: unknown): value is ProviderId {
  return value === 'claude' || value === 'codex'
}

export function migrateProgress(value: unknown): OnboardingProgress {
  if (!value || typeof value !== 'object') return initialProgress()
  const raw = value as Record<string, unknown>
  if (!isActionId(raw.action)) return initialProgress()

  const completed = Array.isArray(raw.completed)
    ? raw.completed.filter(isActionId).filter((action, index, all) => all.indexOf(action) === index)
    : []
  const rawTasks = raw.taskIds && typeof raw.taskIds === 'object'
    ? raw.taskIds as Record<string, unknown>
    : {}

  return initialProgress({
    action: raw.action,
    completed,
    provider: isProvider(raw.provider) ? raw.provider : undefined,
    captureId: typeof raw.captureId === 'string' ? raw.captureId : undefined,
    observedCaptureItemIds: Array.isArray(raw.observedCaptureItemIds)
      ? raw.observedCaptureItemIds.filter((item): item is string => typeof item === 'string')
      : [],
    taskIds: {
      ...(typeof rawTasks.orchestrator === 'string' ? { orchestrator: rawTasks.orchestrator } : {}),
      ...(typeof rawTasks.agent === 'string' ? { agent: rawTasks.agent } : {}),
    },
    meetingId: typeof raw.meetingId === 'string' ? raw.meetingId : undefined,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : Date.now(),
  })
}

export class ProgressStore {
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async load(): Promise<OnboardingProgress> {
    try {
      return migrateProgress(JSON.parse(await fs.readFile(this.path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
        return initialProgress()
      }
      throw error
    }
  }

  async save(value: OnboardingProgress): Promise<void> {
    const operation = this.writes.then(async () => {
      await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temporaryPath, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
        await fs.rename(temporaryPath, this.path)
        await fs.chmod(this.path, 0o600)
      } finally {
        await fs.rm(temporaryPath, { force: true })
      }
    })
    this.writes = operation.catch(() => undefined)
    return operation
  }

  async reset(): Promise<void> {
    await this.writes
    await fs.rm(this.path, { force: true })
  }
}
