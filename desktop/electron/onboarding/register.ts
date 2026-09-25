import type { OnboardingCoordinator } from './coordinator'
import type { OnboardingEvent, PresenterCommand } from './types'

export interface OnboardingRuntimeDeps {
  coordinator: OnboardingCoordinator
  presenter: { show(): void; send(command: PresenterCommand): void; close(): void }
  allowance: { arm(action: PresenterCommand['action']): void; complete(): void }
  onReceipt(listener: (event: OnboardingEvent) => Promise<PresenterCommand>): () => void
  verifyOrchestratorTask(taskId: string, notBeforeMs: number): Promise<boolean>
  onNavigate(destination: 'orchestrator' | 'notetaker' | 'account'): void
}

export class OnboardingRuntime {
  private unsubscribe: (() => void) | undefined
  private verifyTask: OnboardingRuntimeDeps['verifyOrchestratorTask']
  private closing = false

  constructor(private readonly deps: OnboardingRuntimeDeps) {
    this.verifyTask = deps.verifyOrchestratorTask
  }

  async boot(options: { signedIn?: boolean } = {}): Promise<PresenterCommand> {
    this.closing = false
    let command = await this.deps.coordinator.start()
    // Resolve existing accounts before creating a window, even if an old tour
    // checkpoint was left unfinished. Replay is an explicit, separate reset.
    if (options.signedIn && command.action !== 'complete') {
      command = await this.deps.coordinator.dispatch({ type: 'onboarding-dismissed' })
      this.deps.allowance.complete()
    }
    this.unsubscribe?.()
    this.unsubscribe = this.deps.onReceipt(event => this.accept(event))
    if (command.action !== 'complete') {
      this.deps.presenter.show()
      this.publish(command)
    }
    return command
  }

  snapshot(): PresenterCommand { return this.deps.coordinator.snapshot() }

  setVerifyOrchestratorTask(verify: OnboardingRuntimeDeps['verifyOrchestratorTask']): void {
    this.verifyTask = verify
  }

  async accept(event: OnboardingEvent): Promise<PresenterCommand> {
    const before = this.deps.coordinator.currentProgress()
    // Permission changes must not resurrect a completed/dismissed tour.
    if (before.action === 'complete' && event.type === 'boot-revalidated') return this.snapshot()
    if (event.type === 'task-created' && before.action === 'orchestrator-task' && !event.cwd) return this.snapshot()
    if (event.type === 'task-completed' && before.action === 'orchestrator-task') {
      if (event.taskId !== before.taskIds.orchestrator || !(await this.verifyTask(event.taskId, before.updatedAt))) return this.snapshot()
    }
    const command = await this.deps.coordinator.dispatch(event)
    this.publish(command)
    return command
  }

  async reset(): Promise<PresenterCommand> {
    const command = await this.deps.coordinator.reset()
    this.closing = false
    this.deps.presenter.show()
    this.publish(command)
    return command
  }

  async completeOrientation(): Promise<PresenterCommand> {
    this.deps.onNavigate('orchestrator')
    this.deps.onNavigate('notetaker')
    return this.accept({ type: 'capability-satisfied', action: 'product-orientation' })
  }

  async finishAfterSignIn(signedIn: boolean): Promise<PresenterCommand> {
    if (!signedIn || this.snapshot().action !== 'sign-in') return this.snapshot()
    const command = await this.accept({ type: 'capability-satisfied', action: 'sign-in' })
    if (command.action === 'complete') {
      this.deps.allowance.complete()
      this.deps.presenter.close()
    }
    return command
  }

  async dismiss(): Promise<PresenterCommand> {
    // A close click must remove the overlay immediately. Progress writes can
    // wait behind other disk work; leaving the window up during that await
    // makes the whole app look unresponsive.
    this.closing = true
    this.deps.presenter.close()
    this.deps.allowance.complete()
    return this.accept({ type: 'onboarding-dismissed' })
  }

  dispose(): void { this.unsubscribe?.(); this.unsubscribe = undefined }

  private publish(command: PresenterCommand): void {
    if (this.closing) return
    this.deps.allowance.arm(command.action)
    if (command.action !== 'complete') this.deps.presenter.send(command)
  }
}
