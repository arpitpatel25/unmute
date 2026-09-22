import type { ActionId } from './types'

/** Entry effects belong to transitions, not progress/auth/recording snapshots. */
export class ActionEntry {
  private action: ActionId | undefined

  async run(action: ActionId, effect: () => Promise<void>): Promise<void> {
    if (this.action === action) return
    // Claim synchronously, before any effect can yield to another receipt.
    this.action = action
    await effect()
  }
}
