// Managed STT/LLM client — calls the pipeline worker.
//
// The URL is injected at build time via the build script so the OSS engine
// has no idea this endpoint exists. Errors from the pipeline are mapped to
// typed router errors so auto-fallback can decide what to do next.

import type {
  STTOptions,
  STTResult,
  LLMOptions,
  LLMResult,
} from './provider-router'
import {
  InsufficientBalanceError,
  RateLimitedError,
  UpstreamError,
  NetworkError,
  SubscriptionInactiveError,
  UpgradeRequiredError,
} from './provider-router'

// Substituted by the build script. Examples:
//   __PIPELINE_URL__ = 'https://unmute-pipeline.<your-cf-subdomain>.workers.dev'
declare const __PIPELINE_URL__: string

interface PipelineEnvelope<T> {
  ok: boolean
  data?: T
  balance_cents?: number
  cost_cents?: number
  engine?: 'managed'
  code?: string
  message?: string
  top_up_url?: string
  subscribe_url?: string
}

/** Item 5 (fair-use): one-time soft toast signal to the renderer. Fired at most
 *  once per cooldown window so a power user isn't spammed. Best-effort and
 *  silent — must never affect the STT/LLM success path. */
let fairUseNotifiedAt = 0
const FAIR_USE_COOLDOWN_MS = 60 * 60 * 1000 // at most once an hour
function notifyFairUse(): void {
  try {
    const now = Date.now()
    if (now - fairUseNotifiedAt < FAIR_USE_COOLDOWN_MS) return
    fairUseNotifiedAt = now
    // Lazy require so this module stays importable in non-electron test contexts.
    const { BrowserWindow } = require('electron') as typeof import('electron')
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('paywall:fair-use-notify')
    }
  } catch {
    /* best-effort — never block the call path */
  }
}

async function callPipeline<T>(
  path: string,
  init: RequestInit,
  token: string
): Promise<{ data: T; balanceCents: number; costCents: number }> {
  let res: Response
  try {
    res = await fetch(`${__PIPELINE_URL__}${path}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    })
  } catch {
    throw new NetworkError()
  }

  // Item 5 (fair-use): on a SUCCESSFUL managed call the pipeline may set
  // `x-unmute-fair-use: notify` when the user is over the hidden cap. Read it
  // BEFORE parsing the body so a body-parse failure can't swallow it, and emit
  // a soft, one-time renderer toast. NEVER block or throw on this — it's purely
  // informational, so any failure here is swallowed.
  if (res.ok && res.headers.get('x-unmute-fair-use') === 'notify') {
    notifyFairUse()
  }

  let body: PipelineEnvelope<T>
  try {
    body = (await res.json()) as PipelineEnvelope<T>
  } catch {
    throw new UpstreamError(res.status)
  }

  if (!res.ok || !body.ok) {
    // Item 4: distinguish the two entitlement gates so the UI can show the
    // right prompt (subscribe vs upgrade) rather than a generic error.
    //   402 SUBSCRIPTION_INACTIVE → no active sub → "Subscribe to use Unmute"
    //   403 UPGRADE_REQUIRED      → active but wrong plan → "Upgrade for Remote"
    if (res.status === 402 || body.code === 'SUBSCRIPTION_INACTIVE') {
      throw new SubscriptionInactiveError(body.subscribe_url ?? body.top_up_url)
    }
    if (res.status === 403 || body.code === 'UPGRADE_REQUIRED') {
      throw new UpgradeRequiredError(body.subscribe_url ?? body.top_up_url)
    }
    if (body.code === 'INSUFFICIENT_BALANCE') {
      throw new InsufficientBalanceError(body.balance_cents ?? 0)
    }
    if (res.status === 429 || body.code === 'RATE_LIMITED') {
      throw new RateLimitedError()
    }
    throw new UpstreamError(res.status)
  }

  return {
    data: body.data as T,
    balanceCents: body.balance_cents ?? 0,
    costCents: body.cost_cents ?? 0,
  }
}

// ─── STT client ────────────────────────────────────────────────

export interface ManagedSTTClient {
  transcribe(opts: STTOptions, token: string): Promise<STTResult>
}

export const managedSTT: ManagedSTTClient = {
  async transcribe(opts, token): Promise<STTResult> {
    const form = new FormData()
    form.append('file', new Blob([opts.audio], { type: 'audio/webm' }), 'audio.webm')
    form.append('duration_seconds', String(opts.durationSeconds))
    if (opts.language) form.append('language', opts.language)
    if (opts.flowType) form.append('flow_type', opts.flowType)

    type Data = { text: string; duration_seconds: number; model: string }
    const { data, costCents } = await callPipeline<Data>(
      '/v1/stt',
      { method: 'POST', body: form },
      token
    )
    return {
      text: data.text,
      durationSeconds: data.duration_seconds,
      engine: 'managed',
      costCents,
    }
  },
}

// ─── LLM client ────────────────────────────────────────────────

export interface ManagedLLMClient {
  complete(opts: LLMOptions, token: string): Promise<LLMResult>
}

export const managedLLM: ManagedLLMClient = {
  async complete(opts, token): Promise<LLMResult> {
    type Data = { text: string; model: string; prompt_tokens: number; completion_tokens: number }
    const { data, costCents } = await callPipeline<Data>(
      '/v1/llm',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: opts.messages,
          temperature: opts.temperature,
          max_tokens: opts.maxTokens,
        }),
      },
      token
    )
    return { text: data.text, engine: 'managed', costCents }
  },
}

// ─── /v1/me — for periodic balance polling ─────────────────────

export async function fetchMe(token: string): Promise<{
  balanceCents: number
  topUpUrl: string
} | null> {
  try {
    const res = await fetch(`${__PIPELINE_URL__}/v1/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const body = (await res.json()) as {
      ok: boolean
      balance_cents?: number
      top_up_url?: string
    }
    if (!body.ok) return null
    return {
      balanceCents: body.balance_cents ?? 0,
      topUpUrl: body.top_up_url ?? '',
    }
  } catch {
    return null
  }
}

// ─── /v1/me — subscription/entitlement status ──────────────────
// Reads the same status endpoint as the balance poll, but surfaces the
// subscription entitlement so the renderer can show "Unmute" / "Dictation" /
// "Inactive" and the post-checkout poll can detect when a sub goes active.
// Field names are tolerant of a few likely backend shapes; default to inactive.

export type SubscriptionStatus = {
  active: boolean
  plan: 'dictation' | 'unmute' | null
  /**
   * Raw Dodo status: pending | active | on_hold | cancelled | failed | expired
   * (or '' when the user has never subscribed). Carried separately from
   * `active` so the UI can tell "you never subscribed" apart from "your card
   * was declined" — those deserve very different words.
   */
  status: string | null
}

export async function fetchSubscription(token: string): Promise<SubscriptionStatus | null> {
  try {
    const res = await fetch(`${__PIPELINE_URL__}/v1/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const body = (await res.json()) as {
      ok?: boolean
      subscription_active?: boolean
      subscription_plan?: string
      subscription?: { active?: boolean; plan?: string; status?: string } | null
    }
    const sub = body.subscription ?? null
    const active = !!(
      body.subscription_active ||
      sub?.active ||
      sub?.status === 'active'
    )
    const rawPlan = body.subscription_plan ?? sub?.plan ?? null
    const plan = rawPlan === 'unmute' || rawPlan === 'dictation' ? rawPlan : null
    return { active, plan, status: sub?.status ?? null }
  } catch {
    return null
  }
}
