import type { AgentProviderId } from './provider'

/**
 * WHICH MODEL THE AGENT USES — the user's choice first, then the rest of what
 * that provider offers, in the provider's own order.
 *
 * This used to be a constant (Codex → gpt-5.6-sol, Claude → opus). When that
 * one model was unavailable — a spent usage allowance, a plan without it, a
 * retired id — every Agent message failed and the chat stayed blocked, with
 * nothing to choose instead. Now:
 *
 *   - the default per provider is a setting (Unmute Agent settings), with
 *     these constants only as the out-of-the-box value;
 *   - the fallbacks are everything else the provider lists, supplied by the
 *     host from the live catalog (Codex `model/list`, Claude's initialize);
 *   - a model that just failed for availability is skipped for a while, and
 *     tried first again once the cooldown lapses. The user's setting is never
 *     rewritten — the same rule providerHealth.ts follows for providers.
 *
 * Lives in whichever process runs the Agent (the runtime daemon) and in the
 * app for labels; the host pushes choices to both.
 */

const DEFAULT_MODEL: Readonly<Record<AgentProviderId, string>> = {
  codex: 'gpt-5.6-sol',
  claude: 'opus',
}

/** Used only until the live catalog has been read once. */
const STATIC_FALLBACKS: Readonly<Record<AgentProviderId, readonly string[]>> = {
  codex: ['gpt-5.5'],
  claude: ['sonnet'],
}

export interface AgentModelChoice {
  /** The user's default for this provider; absent means the built-in one. */
  model?: string
  /** Everything else the provider offers, in its own order. */
  fallbacks?: string[]
  /** Display names from the provider's catalog, by id. */
  labels?: Record<string, string>
}
export type AgentModelChoices = Partial<Record<AgentProviderId, AgentModelChoice>>

export interface AgentCatalogModel { id: string; label: string }

/** Claude's `default` alias is a real picker choice, but not a concrete model
 *  that can be supplied to `--fallback-model`. Keep those two concerns apart. */
export function claudeAgentModels(models: readonly AgentCatalogModel[]): {
  selectable: AgentCatalogModel[]
  fallbacks: string[]
} {
  return {
    selectable: [...models],
    fallbacks: models.filter(model => model.id !== 'default').map(model => model.id),
  }
}

let choices: AgentModelChoices = {}
export function setAgentModelChoices(next: AgentModelChoices | undefined): void {
  choices = structuredClone(next ?? {})
}
export function agentModelChoices(): AgentModelChoices { return structuredClone(choices) }

/** How long a model that failed for availability is skipped. Long enough to
 *  stop paying a failed request on every message, short enough that a
 *  refreshed allowance is picked up the same session. */
export const MODEL_COOLDOWN_MS = 30 * 60_000
const unavailableUntil = new Map<string, number>()
const key = (provider: AgentProviderId, model: string) => `${provider}:${model}`

export function markModelUnavailable(provider: AgentProviderId, model: string, now = Date.now()): void {
  unavailableUntil.set(key(provider, model), now + MODEL_COOLDOWN_MS)
}
export function markModelWorking(provider: AgentProviderId, model: string): void {
  unavailableUntil.delete(key(provider, model))
}
function coolingDown(provider: AgentProviderId, model: string, now: number): boolean {
  const until = unavailableUntil.get(key(provider, model))
  if (until === undefined) return false
  if (now >= until) { unavailableUntil.delete(key(provider, model)); return false }
  return true
}

/** The built-in default, used until the user picks one. */
export function defaultAgentModel(provider: AgentProviderId): string { return DEFAULT_MODEL[provider] }

/** The user's default for a provider, ignoring cooldowns. */
export function preferredAgentModel(provider: AgentProviderId): string {
  return choices[provider]?.model || DEFAULT_MODEL[provider]
}

/**
 * Every model to try, in order: the default, then the fallbacks. Models in a
 * cooldown move to the end rather than disappearing — if everything is cooling
 * down, trying is still better than refusing.
 */
export function agentModelChain(provider: AgentProviderId, now = Date.now()): string[] {
  const choice = choices[provider]
  const all = [preferredAgentModel(provider), ...(choice?.fallbacks ?? STATIC_FALLBACKS[provider])]
  const unique = all.filter((m, i) => !!m && all.indexOf(m) === i)
  return [...unique.filter(m => !coolingDown(provider, m, now)), ...unique.filter(m => coolingDown(provider, m, now))]
}

/** The model a new Agent turn starts on. */
export function agentModel(provider: AgentProviderId, now = Date.now()): string {
  return agentModelChain(provider, now)[0]
}

/** What to fall back to, in order, if that model is unavailable. */
export function agentFallbackModels(provider: AgentProviderId, now = Date.now()): string[] {
  return agentModelChain(provider, now).slice(1)
}

export function agentModelName(provider: AgentProviderId, model: string): string {
  const known = choices[provider]?.labels?.[model]
  if (known) return known
  if (model === 'opus') return 'Opus'
  if (model === 'sonnet') return 'Sonnet'
  if (model === 'haiku') return 'Haiku'
  // gpt-5.6-sol → GPT-5.6 Sol
  return model.replace(/^gpt-/i, 'GPT-').replace(/-([a-z])([a-z]*)$/i, (_m, a: string, b: string) => ` ${a.toUpperCase()}${b}`)
}

export function agentModelLabel(provider: AgentProviderId): string {
  return agentModelName(provider, preferredAgentModel(provider))
}
