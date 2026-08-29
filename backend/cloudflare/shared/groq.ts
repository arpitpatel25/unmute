// Groq endpoints, model selection, and cost estimation.
//
// All pricing is in cents (integer math) to avoid floating-point drift in the
// ledger. Conversions from per-token / per-second rates happen here.

// ─── Endpoints ──────────────────────────────────────────────────

export const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
export const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions'
// LLM (chat) runs on Cerebras — same OpenAI-compatible shape as Groq, but far
// lower TTFT so a 120B model fits the dictation-cleanup budget. STT stays Groq
// (Cerebras has no Whisper). 2026-07-18: Groq deprecated llama-4-scout, which
// 404'd every /v1/llm call — this move both fixes that and upgrades the model.
export const CEREBRAS_CHAT_URL = 'https://api.cerebras.ai/v1/chat/completions'

// ─── Models (server-side defaults — change here to roll out across all users) ─

export const STT_MODEL = 'whisper-large-v3-turbo' // $0.04 / hour (Groq)
// Note-taking is accuracy-sensitive and routinely multilingual. Keep fast,
// low-cost Turbo for existing dictation, but use the full model for the
// note-taker branch only. Groq explicitly recommends large-v3 when errors and
// multilingual accuracy matter more than the small latency/cost difference.
export const NOTETAKER_STT_MODEL = 'whisper-large-v3' // $0.111 / hour (Groq)
export const LLM_MODEL = 'gpt-oss-120b' // Cerebras — ~0.6s round-trip, strong quality

// ─── Pricing (USD) ──────────────────────────────────────────────

/** STT cost per second of audio (USD). */
const STT_COST_PER_SECOND = 0.04 / 3600 // $0.04/hr → $0.0000111/s
const NOTETAKER_STT_COST_PER_SECOND = 0.111 / 3600

function sttPricePerSecond(model = STT_MODEL): number {
  return model === NOTETAKER_STT_MODEL ? NOTETAKER_STT_COST_PER_SECOND : STT_COST_PER_SECOND
}

/** LLM cost per token (USD). Cerebras gpt-oss-120b. */
const LLM_INPUT_PRICE = 0.35 / 1_000_000 // $0.35 per million input tokens
const LLM_OUTPUT_PRICE = 0.75 / 1_000_000 // $0.75 per million output tokens

// ─── Markup ─────────────────────────────────────────────────────

/** 2x markup over Groq's actual cost. Covers Cloudflare + Supabase + Dodo
 *  fees (Dodo: ~4% + $0.40 + 1.5% intl; payout MoR cut amortizes to ~8-11%
 *  on small top-ups) and leaves a ~40% net margin. Tunable, but should be
 *  treated as a real price — not a beta number — since per-request cost is
 *  surfaced to the user in the in-app usage history. Bumping later would be
 *  noticed by power users. */
export const MARKUP_MULTIPLIER = 2.0

// ─── Cost calculators (return integer cents, rounded UP) ────────

/** Estimate cost in cents BEFORE the call, used to short-circuit if the user
 *  doesn't have enough balance for a worst-case request. We estimate the
 *  STT portion only since LLM cost is small and the audio duration is the
 *  dominant variable. Adds a small fudge factor for the LLM half. */
export function estimateMaxCostCents(durationSeconds: number): number {
  const rawUsd = STT_COST_PER_SECOND * durationSeconds + 0.001 // +$0.001 LLM headroom
  const marked = rawUsd * MARKUP_MULTIPLIER
  return Math.ceil(marked * 100)
}

/** Compute the actual STT cost AFTER the call (integer cents with markup). */
export function sttCostCents(durationSeconds: number, model = STT_MODEL): number {
  const rawUsd = sttPricePerSecond(model) * durationSeconds
  return Math.ceil(rawUsd * MARKUP_MULTIPLIER * 100)
}

/** Compute the actual LLM cost AFTER the call (integer cents with markup). */
export function llmCostCents(promptTokens: number, completionTokens: number): number {
  const rawUsd = LLM_INPUT_PRICE * promptTokens + LLM_OUTPUT_PRICE * completionTokens
  return Math.ceil(rawUsd * MARKUP_MULTIPLIER * 100)
}

/** Raw Groq cost (no markup) — used in usage_logs for accounting. */
export function rawGroqCostUsd(
  call: 'stt' | 'llm',
  params: { durationSeconds?: number; promptTokens?: number; completionTokens?: number; model?: string }
): number {
  if (call === 'stt') return sttPricePerSecond(params.model) * (params.durationSeconds ?? 0)
  return (
    LLM_INPUT_PRICE * (params.promptTokens ?? 0) +
    LLM_OUTPUT_PRICE * (params.completionTokens ?? 0)
  )
}
