// Provider router — picks Managed / BYOK / Local for each transcription
// based on user state and the explicit Settings → Engine preference.
//
// State inputs (all are reactive — the router re-evaluates on every call):
//   * Signed in to managed cloud?       (has Supabase session)
//   * Balance > $0?                     (read from main-process balance cache)
//   * BYOK Groq API key set & valid?    (read from existing OSS engine keyStore)
//   * Local whisper model + binary ready?
//
// Engine setting (from Settings → Engine), default 'auto':
//   * 'auto'      — Managed → BYOK → Local priority chain
//   * 'managed'   — only Managed (no fallback on 402, surface top-up)
//   * 'byok'      — only BYOK (no fallback on auth error)
//   * 'local'     — only Local (never touches network)
//
// Per-call fallback (auto mode only):
//   Managed → 402/5xx/timeout  → BYOK if C, else Local if D, else error
//   BYOK    → 401/429/timeout  → Local if D, else error
//   Local   → failure          → hard error (Local is the floor)

import type { ManagedSTTClient, ManagedLLMClient } from './managed-client'

export type EngineMode = 'auto' | 'managed' | 'byok' | 'local'
export type Provider = 'managed' | 'byok' | 'local'

export interface ProviderState {
  signedIn: boolean
  balanceCents: number
  byokKeySet: boolean
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
export class InvalidByokKeyError extends Error {
  constructor() { super('INVALID_BYOK_KEY') }
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
  if (mode === 'managed') return state.signedIn && state.balanceCents > 0 ? 'managed' : null
  if (mode === 'byok') return state.byokKeySet ? 'byok' : null
  if (mode === 'local') return state.localReady ? 'local' : null

  // mode === 'auto' — priority chain
  if (state.signedIn && state.balanceCents > 0) return 'managed'
  if (state.byokKeySet) return 'byok'
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
    if (state.byokKeySet) return 'byok'
    if (state.localReady) return 'local'
    return null
  }
  if (failed === 'byok') {
    if (state.localReady) return 'local'
    return null
  }
  return null // local is the floor
}

// ─── Provider implementation interfaces ────────────────────────

export interface ByokSTT {
  transcribe(opts: STTOptions, apiKey: string): Promise<STTResult>
}
export interface LocalSTT {
  transcribe(opts: STTOptions): Promise<STTResult>
}
export interface ByokLLM {
  complete(opts: LLMOptions, apiKey: string): Promise<LLMResult>
}
// Local LLM does not currently exist — formatting falls back to "no formatting"
// when in local mode (the raw transcript is pasted). That matches v1.3.4 behavior.

// ─── Router with auto-fallback ─────────────────────────────────

export interface RouterDeps {
  managedSTT: ManagedSTTClient
  managedLLM: ManagedLLMClient
  byokSTT: ByokSTT
  byokLLM: ByokLLM
  localSTT: LocalSTT
  getState: () => Promise<ProviderState>
  getEngineMode: () => Promise<EngineMode>
  getByokKey: () => Promise<string | null>
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
    // LLM is only meaningful for managed and byok. Local has no LLM.
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
    if (provider === 'byok') {
      const key = await this.deps.getByokKey()
      if (!key) throw new InvalidByokKeyError()
      return await this.deps.byokSTT.transcribe(opts, key)
    }
    return await this.deps.localSTT.transcribe(opts)
  }

  private async completeWith(provider: Provider, opts: LLMOptions): Promise<LLMResult> {
    if (provider === 'managed') {
      const token = await this.deps.getAccessToken()
      if (!token) throw new Error('NOT_SIGNED_IN')
      return await this.deps.managedLLM.complete(opts, token)
    }
    if (provider === 'byok') {
      const key = await this.deps.getByokKey()
      if (!key) throw new InvalidByokKeyError()
      return await this.deps.byokLLM.complete(opts, key)
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
  if (provider === 'byok') {
    return (
      e instanceof InvalidByokKeyError ||
      e instanceof RateLimitedError ||
      e instanceof NetworkError
    )
  }
  return false // local errors are hard errors
}
