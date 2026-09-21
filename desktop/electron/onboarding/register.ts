import type { OnboardingCoordinator } from './coordinator'
import type { OnboardingEvent, PresenterCommand } from './types'

export interface OnboardingRuntimeDeps {
  coordinator: OnboardingCoordinator
  presenter: { show(): void; send(command: PresenterCommand): void; close(): void }
  allowance: { arm(action: PresenterCommand['action']): void; complete(): void }
  onReceipt(listener: (event: OnboardingEvent) => void): () => void
  verifyOrchestratorTask(taskId: string, notBeforeMs: number): Promise<boolean>
  onNavigate(destination: 'orchestrator' | 'notetaker' | 'account'): void
}

export class OnboardingRuntime {
  private unsubscribe: (() => void) | undefined
  private verifyTask: OnboardingRuntimeDeps['verifyOrchestratorTask']

  constructor(private readonly deps: OnboardingRuntimeDeps) {
    this.verifyTask = deps.verifyOrchestratorTask
  }

  async boot(): Promise<PresenterCommand> {
    const command = await this.deps.coordinator.start()
    this.unsubscribe?.()
    this.unsubscribe = this.deps.onReceipt(event => { void this.accept(event) })
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

  dispose(): void { this.unsubscribe?.(); this.unsubscribe = undefined }

  private publish(command: PresenterCommand): void {
    this.deps.allowance.arm(command.action)
    if (command.action !== 'complete') this.deps.presenter.send(command)
  }
}
