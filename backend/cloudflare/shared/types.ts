// Shared types across unmute-cloud workers.

import type { KVNamespace } from '@cloudflare/workers-types'

export interface PipelineEnv {
  // Set via `wrangler secret put`
  GROQ_API_KEY: string
  OPENROUTER_API_KEY: string // Notetaker Qwen primary; never shipped to the desktop client
  CEREBRAS_API_KEY: string // /v1/llm runs on Cerebras (gpt-oss-120b); STT stays Groq
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  ONBOARDING_GRANT_SECRET: string
  BUG_REPORT_ADMIN_PASSWORD: string

  // KV namespace binding (declared in wrangler.toml)
  USER_BALANCE: KVNamespace
  ONBOARDING_ALLOWANCE: DurableObjectNamespace
}

export interface PaymentsEnv {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string

  // Dodo Payments. Set via `wrangler secret put` (do not commit values).
  DODO_API_KEY: string
  DODO_WEBHOOK_SECRET: string

  // Dodo API host — test or live. Set per-environment in wrangler.toml.
  //   test → https://test.dodopayments.com
  //   live → https://live.dodopayments.com
  DODO_API_BASE: string

  // JSON map of "<plan>:<interval>" → recurring Dodo product_id.
  //   e.g. '{"dictation:month":"pdt_...","unmute:year":"pdt_..."}'
  // Products are created out-of-band in the Dodo dashboard.
  DODO_SUBSCRIPTION_PRODUCTS: string

  // Base URL for the return-page bounce (rendered by this worker).
  //   e.g. https://api.unmute.app  (then /checkout/return is appended)
  PUBLIC_API_BASE: string

  // Escape hatch for the test-mode deployment. When DODO_API_BASE points at
  // test.dodopayments.com this worker REFUSES to write entitlement state unless
  // this is the string 'true'. Both deployments share one Supabase project and
  // one KV namespace, and a test-mode subscription going on_hold once revoked a
  // live customer's access. See isTestMode() in payments/src/index.ts.
  ALLOW_TEST_MODE_WRITES?: string

  USER_BALANCE: KVNamespace
}

export interface JWTPayload {
  sub: string // user ID (UUID)
  email?: string
  exp: number
  iat: number
  iss: string
  role?: string
}

/** STT transcription request body sent by desktop client to /v1/stt */
export interface STTRequestMetadata {
  model?: string
  language?: string
  prompt?: string
  flowType?: 'dictation' | 'transform' | 'quote' | 'context'
}

/** Response envelope from the pipeline worker. */
export interface PipelineResponse<T> {
  ok: true
  data: T
  balance_cents: number
  cost_cents: number
  engine: 'managed'
}

export interface PipelineErrorResponse {
  ok: false
  code:
    | 'UNAUTHORIZED'
    | 'INSUFFICIENT_BALANCE'
    | 'SUBSCRIPTION_INACTIVE'
    | 'UPGRADE_REQUIRED'
    | 'UPSTREAM_ERROR'
    | 'BAD_REQUEST'
    | 'RATE_LIMITED'
    | 'INTERNAL_ERROR'
  message: string
  balance_cents?: number
  top_up_url?: string
  subscribe_url?: string
}

export interface STTResult {
  text: string
  duration_seconds: number
  model: string
}

export interface LLMRequest {
  model?: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  temperature?: number
  max_tokens?: number
}

export interface LLMResult {
  text: string
  model: string
  prompt_tokens: number
  completion_tokens: number
}
