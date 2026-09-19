import { presenterSnapshot } from './chapters'
import { initialProgress, reduceOnboarding } from './machine'
import type { OnboardingEvent, OnboardingProgress, PresenterCommand } from './types'
import type { ProgressStore } from './progress-store'

export class OnboardingCoordinator {
  private progress: OnboardingProgress | undefined
  private operations: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: ProgressStore,
    private readonly clock: () => number = Date.now,
  ) {}

  async start(): Promise<PresenterCommand> {
    this.progress = await this.store.load()
    return this.snapshot()
  }

  currentProgress(): OnboardingProgress {
    if (!this.progress) throw new Error('OnboardingCoordinator.start() must be called first')
    return this.progress
  }

  snapshot(): PresenterCommand {
    const progress = this.currentProgress()
    return presenterSnapshot(progress.action, progress.gesture)
  }

  dispatch(event: OnboardingEvent): Promise<PresenterCommand> {
    return this.serialize(async () => {
      const current = this.currentProgress()
      const reduced = reduceOnboarding(current, event)
      if (reduced !== current) {
        this.progress = { ...reduced, updatedAt: this.clock() }
        await this.store.save(this.progress)
      }
      return this.snapshot()
    })
  }

  reset(): Promise<PresenterCommand> {
    return this.serialize(async () => {
      await this.store.reset()
      this.progress = initialProgress({ updatedAt: this.clock() })
      return this.snapshot()
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation)
    this.operations = result.catch(() => undefined)
    return result
  }
}
