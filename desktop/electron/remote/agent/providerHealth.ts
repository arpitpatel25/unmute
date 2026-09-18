// Remembering provider health without changing the provider the user chose.
//
// The Agent lane reads ONE setting — `unmuteAgentProvider` — and, before this
// module, repeatedly retried it while unavailable. Health state can suppress
// wasteful background retries, but it must never route an interaction to a
// different provider: provider identity is a user-visible decision.
//
// WHY NO ERROR CLASSIFICATION. An earlier design parsed the failure text to
// tell "out of credits" from "auth expired" from a network blip, and parsed the
// reset timestamp out of the message. That is a lot of string matching against
// another tool's human-readable output, which changes without notice. A failure
// is a failure, so any failure counts and the cooldown is a fixed window rather
// than a parsed deadline.
//
// WHY A COOLDOWN. Remembering the failure lets automatic background work avoid
// repeatedly launching a broken provider. It is scheduling state, never
// permission to substitute another provider.
//
// WHY THE USER'S SETTING IS NEVER WRITTEN. This state is in-memory and
// deliberately not persisted. The Notetaker's equivalent calls
// saveNotetakerSettings() and rewrites the user's choice, so a provider that
// was briefly unreachable silently becomes their new permanent setting. Here
// the selection in Settings stays exactly what the user picked; the fallback is
// a temporary routing decision that expires on its own. When the preferred
// provider starts working again it is used again, with nothing to undo.

import type { AgentProviderId } from './provider'

/**
 * How long a failed provider is skipped.
 *
 * Hours, not minutes. The failures worth routing around are not blips — a spent
 * usage allowance, an expired login, an uninstalled CLI — and they are measured
 * in hours or days. A short window would return to the broken provider while it
 * is still broken, which is the wasteful behaviour this exists to stop. The
 * cost of overshooting is only that the preferred provider resumes later than
 * it strictly had to.
 */
export const PROVIDER_COOLDOWN_MS = 2 * 60 * 60_000

/** The order tried when the preferred provider is cooling down. */
export const PROVIDER_IDS: readonly AgentProviderId[] = ['claude', 'codex']

export type ProviderHealthSnapshot = {
  provider: AgentProviderId
  /** When the cooldown lapses. Absent once the provider is usable again. */
  until?: number
}

/**
 * Which providers are currently in a cooldown, and until when.
 *
 * Deliberately a plain in-memory Map with no persistence: a restart is a
 * perfectly good reason to try the preferred provider again, and writing this
 * to disk would turn a transient routing decision into durable state the user
 * cannot see or clear.
 */
export class ProviderHealth {
  private readonly failedUntil = new Map<AgentProviderId, number>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly cooldownMs: number = PROVIDER_COOLDOWN_MS,
  ) {}

  /** Records that a request to `provider` failed. Any failure counts. */
  markFailed(provider: AgentProviderId): void {
    this.failedUntil.set(provider, this.now() + this.cooldownMs)
  }

  /** Clears a cooldown early — a provider that just succeeded is working. */
  markWorking(provider: AgentProviderId): void {
    this.failedUntil.delete(provider)
  }

  /**
   * A lapsed cooldown is indistinguishable from never having failed, so the
   * entry is dropped on read rather than swept on a timer.
   */
  isUsable(provider: AgentProviderId): boolean {
    const until = this.failedUntil.get(provider)
    if (until === undefined) return true
    if (this.now() >= until) {
      this.failedUntil.delete(provider)
      return true
    }
    return false
  }

  /**
   * Which providers a request may use, in order. The chosen one alone, unless
   * the user allowed switching when it cannot answer (Unmute Agent settings,
   * on by default) — then every other installed provider after it, and the
   * chosen one moves behind them while it is cooling down. Never silent: the
   * caller logs the switch, and the setting itself is never rewritten.
   */
  order(
    preferred: AgentProviderId,
    installed: (provider: AgentProviderId) => boolean = () => true,
    allowSwitch = false,
  ): AgentProviderId[] {
    if (!allowSwitch) return [preferred]
    const others = PROVIDER_IDS.filter(p => p !== preferred && installed(p) && this.isUsable(p))
    return this.isUsable(preferred) ? [preferred, ...others] : [...others, preferred]
  }

  /** For logging and the availability payload the UI reads. */
  snapshot(): ProviderHealthSnapshot[] {
    return PROVIDER_IDS.map((provider) => {
      const until = this.failedUntil.get(provider)
      return until !== undefined && this.now() < until
        ? { provider, until }
        : { provider }
    })
  }
}
