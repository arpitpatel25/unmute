// Provider router — picks Managed / Local for each transcription
// based on user state and the explicit Settings → Engine preference.
//
// State inputs (all are reactive — the router re-evaluates on every call):
//   * Signed in to managed cloud?       (has Supabase session)
//   * Balance > $0?                     (read from main-process balance cache)
//   * Local whisper model + binary ready?
//
// Engine setting (from Settings → Engine), default 'auto':
//   * 'auto'      — Managed → Local priority chain
//   * 'managed'   — only Managed (no fallback on 402, surface top-up)
//   * 'local'     — only Local (never touches network)
//
// Per-call fallback (auto mode only):
//   Managed → 402/5xx/timeout  → Local if ready, else error
//   Local   → failure          → hard error (Local is the floor)

import type { ManagedSTTClient, ManagedLLMClient } from './managed-client'

export type EngineMode = 'auto' | 'managed' | 'local'
export type Provider = 'managed' | 'local'

export interface ProviderState {
  signedIn: boolean
  subActive: boolean
  localReady: boolean
}

export interface STTOptions {
  audio: Buffer
  durationSeconds: number
  language?: string
  flowType?: string
}

export interface LLMOptions {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  temperature?: number
  maxTokens?: number
}

export interface STTResult {
  text: string
  durationSeconds: number
  engine: Provider
  costCents: number
}

export interface LLMResult {
  text: string
  engine: Provider
  costCents: number
}

// Typed errors so the router can decide what to do on failure.
export class InsufficientBalanceError extends Error {
  constructor(public balanceCents: number) {
    super('INSUFFICIENT_BALANCE')
  }
}
export class RateLimitedError extends Error {
  constructor() { super('RATE_LIMITED') }
}
export class UpstreamError extends Error {
  constructor(public status: number) { super(`UPSTREAM_${status}`) }
}
export class NetworkError extends Error {
  constructor() { super('NETWORK_ERROR') }
}

// ─── Pure picker — testable, no side effects ───────────────────

/**
 * Given current state + setting, return the provider to try FIRST.
 * The caller is responsible for fallback if that provider fails.
 */
export function pickProvider(state: ProviderState, mode: EngineMode): Provider | null {
  if (mode === 'managed') return state.signedIn && state.subActive ? 'managed' : null
  if (mode === 'local') return state.localReady ? 'local' : null

  // mode === 'auto' — priority chain
  if (state.signedIn && state.subActive) return 'managed'
  if (state.localReady) return 'local'
  return null
}

/**
 * Given a failure and the current state, return the next provider to try
 * in auto mode (or null if no fallback available).
 */
export function nextFallback(
  failed: Provider,
  state: ProviderState,
  mode: EngineMode
): Provider | null {
  if (mode !== 'auto') return null // strict modes don't fall back
  if (failed === 'managed') {
    if (state.localReady) return 'local'
    return null
  }
  return null // local is the floor
}

// ─── Provider implementation interfaces ────────────────────────

export interface LocalSTT {
  transcribe(opts: STTOptions): Promise<STTResult>
}
// Local LLM does not currently exist — formatting falls back to "no formatting"
// when in local mode (the raw transcript is pasted). That matches v1.3.4 behavior.

// ─── Router with auto-fallback ─────────────────────────────────

export interface RouterDeps {
  managedSTT: ManagedSTTClient
  managedLLM: ManagedLLMClient
  localSTT: LocalSTT
  getState: () => Promise<ProviderState>
  getEngineMode: () => Promise<EngineMode>
  getAccessToken: () => Promise<string | null>
  onProviderUsed?: (provider: Provider, costCents: number) => void
}

export class ProviderRouter {
  constructor(private deps: RouterDeps) {}

  async transcribe(opts: STTOptions): Promise<STTResult> {
    const state = await this.deps.getState()
    const mode = await this.deps.getEngineMode()
    const initial = pickProvider(state, mode)
    if (!initial) {
      throw new Error('NO_PROVIDER_AVAILABLE')
    }
    return await this.runWithFallback(
      'stt',
      initial,
      state,
      mode,
      (p) => this.transcribeWith(p, opts),
    )
  }

  async complete(opts: LLMOptions): Promise<LLMResult> {
    const state = await this.deps.getState()
    const mode = await this.deps.getEngineMode()
    const initial = pickProvider(state, mode)
    if (!initial) {
      throw new Error('NO_PROVIDER_AVAILABLE')
    }
    // LLM is only meaningful for managed. Local has no LLM.
    if (initial === 'local') {
      throw new Error('LLM_UNAVAILABLE_IN_LOCAL_MODE')
    }
    return await this.runWithFallback(
      'llm',
      initial,
      state,
      mode,
      (p) => this.completeWith(p, opts),
    )
  }

  // ─── Internal: try one provider, then fall back per mode rules ─

  private async runWithFallback<T extends { engine: Provider; costCents: number }>(
    _kind: 'stt' | 'llm',
    initial: Provider,
    state: ProviderState,
    mode: EngineMode,
    run: (p: Provider) => Promise<T>
  ): Promise<T> {
    let current: Provider | null = initial
    let lastError: Error | null = null

    while (current) {
      try {
        const result = await run(current)
        this.deps.onProviderUsed?.(current, result.costCents)
        return result
      } catch (e) {
        lastError = e as Error
        // Decide if this error is fallback-worthy
        const fallthrough = shouldFallback(current, lastError)
        if (!fallthrough) throw lastError
        current = nextFallback(current, state, mode)
      }
    }

    throw lastError ?? new Error('ALL_PROVIDERS_FAILED')
  }

  private async transcribeWith(provider: Provider, opts: STTOptions): Promise<STTResult> {
    if (provider === 'managed') {
      const token = await this.deps.getAccessToken()
      if (!token) throw new Error('NOT_SIGNED_IN')
      return await this.deps.managedSTT.transcribe(opts, token)
    }
    return await this.deps.localSTT.transcribe(opts)
  }

  private async completeWith(provider: Provider, opts: LLMOptions): Promise<LLMResult> {
    if (provider === 'managed') {
      const token = await this.deps.getAccessToken()
      if (!token) throw new Error('NOT_SIGNED_IN')
      return await this.deps.managedLLM.complete(opts, token)
    }
    throw new Error('LLM_UNAVAILABLE_IN_LOCAL_MODE')
  }
}

/** Decide whether the router should try the next provider given this error. */
function shouldFallback(provider: Provider, e: Error): boolean {
  if (provider === 'managed') {
    return (
      e instanceof InsufficientBalanceError ||
      e instanceof RateLimitedError ||
      e instanceof UpstreamError ||
      e instanceof NetworkError
    )
  }
  return false // local errors are hard errors
}
