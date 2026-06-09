// unmute-cloud / pipeline worker
//
// The ONLY public endpoint hit by managed-cloud users. Routes:
//   POST /v1/stt   — Speech-to-text via Groq Whisper Turbo
//   POST /v1/llm   — Chat completion via Groq Llama-4-Scout
//   GET  /v1/me    — Lightweight balance + plan info (for desktop polling)
//
// Hot-path design (optimized vs BoloAI's pipeline):
//   1. JWT verify — local, cached JWK (~5ms)
//   2. KV balance check — edge read (~5ms)
//   3. Reject with 402 if balance < estimated cost (returns immediately)
//   4. Forward to Groq, STREAM response back (never buffer)
//   5. After response: fire-and-forget (ctx.waitUntil):
//        - usage_logs insert
//        - debit_wallet RPC (creates ledger row + decrements Supabase balance)
//        - KV cache update with new balance
//   6. NO synchronous Supabase round-trip in the hot path
//
// Errors:
//   401 — missing/invalid JWT
//   402 — insufficient balance (returns balance + top_up_url)
//   400 — bad request body
//   429 — Groq rate-limited (passes through)
//   5xx — upstream Groq failure (we surface, no retry)

import { verifyJWT, extractBearer } from '../../shared/auth'
import {
  getBalance,
  cacheDebit,
  setBalance,
} from '../../shared/balance'
import {
  GROQ_STT_URL,
  GROQ_CHAT_URL,
  STT_MODEL,
  LLM_MODEL,
  estimateMaxCostCents,
  sttCostCents,
  llmCostCents,
  rawGroqCostUsd,
} from '../../shared/groq'
import { rpc } from '../../shared/supabase'
import type {
  PipelineEnv,
  PipelineErrorResponse,
  LLMRequest,
} from '../../shared/types'

// ─── Top-up URL surfaced in 402 responses (frontend uses this to deep-link) ─
// Keeping this hardcoded means non-paying users never see it — the only path
// to a 402 is being a signed-in managed user, who already has an account.
const TOP_UP_URL = 'https://unmute.app/topup' // placeholder — Dodo later

// ─── Request size limits ────────────────────────────────────────
const MAX_AUDIO_BYTES = 50 * 1024 * 1024 // 50 MB — covers ~50min of opus audio
const MAX_LLM_BYTES = 1 * 1024 * 1024 // 1 MB — generous

// ─── CORS ───────────────────────────────────────────────────────
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  })
}

function err(
  code: PipelineErrorResponse['code'],
  message: string,
  status: number,
  extra: Partial<PipelineErrorResponse> = {}
): Response {
  const body: PipelineErrorResponse = { ok: false, code, message, ...extra }
  return json(body, status)
}

// ─── Main fetch handler ─────────────────────────────────────────

export default {
  async fetch(req: Request, env: PipelineEnv, ctx: ExecutionContext): Promise<Response> {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    const url = new URL(req.url)

    // ─── Auth: extract + verify JWT ─────────────────────────────
    const token = extractBearer(req)
    if (!token) return err('UNAUTHORIZED', 'Missing bearer token', 401)

    const payload = await verifyJWT(token, env.SUPABASE_URL)
    if (!payload?.sub) return err('UNAUTHORIZED', 'Invalid token', 401)

    const userId = payload.sub

    // ─── Route ──────────────────────────────────────────────────
    try {
      if (req.method === 'GET' && url.pathname === '/v1/me') {
        return await handleMe(env, userId)
      }
      if (req.method === 'POST' && url.pathname === '/v1/stt') {
        return await handleSTT(req, env, ctx, userId)
      }
      if (req.method === 'POST' && url.pathname === '/v1/stt-stream') {
        return await handleSTTStream(req, env, ctx, userId)
      }
      if (req.method === 'POST' && url.pathname === '/v1/llm') {
        return await handleLLM(req, env, ctx, userId)
      }
      return err('BAD_REQUEST', `No route for ${req.method} ${url.pathname}`, 404)
    } catch (e) {
      console.error('[pipeline] unhandled error:', e)
      return err('INTERNAL_ERROR', 'Something went wrong', 500)
    }
  },
}

// ─── GET /v1/me — balance + plan snapshot ──────────────────────

async function handleMe(env: PipelineEnv, userId: string): Promise<Response> {
  // Bypass the 60s KV edge cache here — the desktop app polls /v1/me right
  // after a top-up and the user is watching for the bump. Hot paths (STT,
  // LLM) continue to use the cached path for speed.
  const balance = await getBalance(env, userId, { fresh: true })
  return json({
    ok: true,
    user_id: userId,
    balance_cents: balance,
    top_up_url: TOP_UP_URL,
  })
}

// ─── POST /v1/stt — speech-to-text ─────────────────────────────

async function handleSTT(
  req: Request,
  env: PipelineEnv,
  ctx: ExecutionContext,
  userId: string
): Promise<Response> {
  const tEnter = Date.now()
  // Read content length cheaply to reject oversized uploads before parsing.
  const cl = parseInt(req.headers.get('Content-Length') || '0', 10)
  if (cl > MAX_AUDIO_BYTES) {
    return err('BAD_REQUEST', 'Audio too large (max 50MB)', 413)
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return err('BAD_REQUEST', 'Invalid multipart body', 400)
  }
  const tParsed = Date.now()

  const file = form.get('file')
  if (!(file instanceof File) && !(file instanceof Blob)) {
    return err('BAD_REQUEST', 'Missing "file" part', 400)
  }

  // Optional client-side metadata
  const duration = parseFloat((form.get('duration_seconds') as string) || '0') || estimateDurationFromBytes(file.size)
  const language = (form.get('language') as string) || 'en'
  const flowType = (form.get('flow_type') as string) || 'dictation'

  // ─── Balance check (KV — fast) ────────────────────────────────
  const balanceBefore = await getBalance(env, userId)
  const tBalanceChecked = Date.now()
  const estCostCents = estimateMaxCostCents(duration)

  if (balanceBefore < estCostCents) {
    return err('INSUFFICIENT_BALANCE', 'Top up to use managed cloud', 402, {
      balance_cents: balanceBefore,
      top_up_url: TOP_UP_URL,
    })
  }

  // ─── Forward to Groq ──────────────────────────────────────────
  // response_format: 'json' (vs verbose_json) — smaller response body,
  // ~20-30ms faster to stream back. We don't need the verbose fields.
  const groqForm = new FormData()
  groqForm.append('file', file, (file as File).name || 'audio.webm')
  groqForm.append('model', STT_MODEL)
  groqForm.append('response_format', 'json')
  groqForm.append('temperature', '0')
  groqForm.append('language', language)

  const tGroqStart = Date.now()
  const groqRes = await fetch(GROQ_STT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: groqForm,
  })
  const tGroqHeaders = Date.now()       // TTFB
  const groqTtfbMs = tGroqHeaders - tGroqStart

  if (!groqRes.ok) {
    const txt = await groqRes.text().catch(() => '')
    console.error('[pipeline] Groq STT failed:', groqRes.status, txt.slice(0, 200))
    return err(
      groqRes.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR',
      `Groq STT returned ${groqRes.status}`,
      groqRes.status === 429 ? 429 : 502
    )
  }

  // With response_format=json the body is just { text }. Use the client-
  // provided duration (we receive it in the form's duration_seconds field).
  type GroqSTTResult = { text: string }
  const groqJson = (await groqRes.json()) as GroqSTTResult
  const tGroqBody = Date.now()           // full body received + parsed
  const groqBodyMs = tGroqBody - tGroqHeaders
  const latencyMs = tGroqBody - tGroqStart   // full Groq round-trip
  const actualDuration = duration

  // ─── Cost calculation ────────────────────────────────────────
  const costCents = sttCostCents(actualDuration)
  // Compute new balance LOCALLY (no KV write in hot path).
  // The actual KV write happens inside ctx.waitUntil below — saves ~300ms
  // because Cloudflare KV writes are slow-globally-consistent (~200-400ms).
  const balanceAfter = balanceBefore - costCents

  // ─── Fire-and-forget reconcile + logging + KV update ───────
  // Everything below runs AFTER the response is sent. Critical for latency.
  ctx.waitUntil(
    (async () => {
      // 1. Update KV cache with new balance (in background)
      await setBalance(env.USER_BALANCE, userId, balanceAfter)

      // 2. Single Supabase RPC: insert usage_log + debit wallet atomically
      const result = await rpc<Array<{ usage_log_id: string; new_balance: number }>>(env, 'log_and_debit', {
        p_user_id: userId,
        p_amount_cents: costCents,
        p_call_type: 'stt',
        p_flow_type: flowType,
        p_provider: 'groq',
        p_model: STT_MODEL,
        p_prompt_tokens: 0,
        p_completion_tokens: 0,
        p_audio_duration_seconds: actualDuration,
        p_estimated_cost: rawGroqCostUsd('stt', { durationSeconds: actualDuration }),
        p_latency_ms: latencyMs,
        p_metadata: { model: STT_MODEL, duration_seconds: actualDuration },
      })

      // 3. Reconcile KV with Supabase if they drift (rare)
      const supabaseBalance = result?.[0]?.new_balance
      if (typeof supabaseBalance === 'number' && supabaseBalance !== balanceAfter) {
        await setBalance(env.USER_BALANCE, userId, supabaseBalance)
      }
    })().catch((e) => console.error('[pipeline] reconcile error:', e))
  )

  const tDone = Date.now()
  return json({
    ok: true,
    data: {
      text: groqJson.text,
      duration_seconds: actualDuration,
      model: STT_MODEL,
    },
    balance_cents: balanceAfter,
    cost_cents: costCents,
    engine: 'managed',
    timing_ms: {
      parse: tParsed - tEnter,                  // FormData parse
      balance: tBalanceChecked - tParsed,       // KV read (+ Supabase miss path)
      groq_ttfb: groqTtfbMs,                    // Worker→Groq→headers (TTFB)
      groq_body: groqBodyMs,                    // Groq response body streaming + parse
      groq_total: latencyMs,                    // Full Groq round-trip
      worker_total: tDone - tEnter,             // All worker-side time
    },
  })
}

// ─── POST /v1/stt-stream — streamed STT ────────────────────────
// Body is the raw WebM/Opus bytes (NOT multipart). Metadata comes via
// query string + headers so the worker can pull bytes from req.body as
// a ReadableStream. Cloudflare buffers the body at the edge before
// invoking the handler, but bytes still flow over the wire in real time
// as the client streams them — saving the post-Fn-stop upload wait.

async function handleSTTStream(
  req: Request,
  env: PipelineEnv,
  ctx: ExecutionContext,
  userId: string
): Promise<Response> {
  const tEnter = Date.now()
  if (!req.body) {
    return err('BAD_REQUEST', 'Missing body', 400)
  }

  const url = new URL(req.url)
  const duration = parseFloat(url.searchParams.get('duration_seconds') || '0') || 0
  const language = url.searchParams.get('language') || 'en'
  const flowType = url.searchParams.get('flow_type') || 'dictation'

  // ─── Balance check (KV — fast) — done while body buffers at edge ──
  const balanceBefore = await getBalance(env, userId)
  const tBalanceChecked = Date.now()
  // We don't know exact duration yet, but the client estimate is reliable
  // (it comes from the actual MediaRecorder timestamps). If unset, reserve $0.10.
  const estCostCents = duration > 0 ? estimateMaxCostCents(duration) : 10
  if (balanceBefore < estCostCents) {
    return err('INSUFFICIENT_BALANCE', 'Top up to use managed cloud', 402, {
      balance_cents: balanceBefore,
      top_up_url: TOP_UP_URL,
    })
  }

  // ─── Drain body stream into a Uint8Array ─────────────────────────
  // CF buffers internally so this returns ~instantly once stream closes.
  const tDrainStart = Date.now()
  const chunks: Uint8Array[] = []
  // Record arrival times of first 5 chunks — tells us whether CF delivered
  // the body all at once (buffered) or progressively (streaming).
  const earlyArrivals: Array<{ at: number; bytes: number }> = []
  const reader = req.body.getReader()
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      totalBytes += value.byteLength
      if (earlyArrivals.length < 5) {
        earlyArrivals.push({ at: Date.now() - tDrainStart, bytes: value.byteLength })
      }
    }
  }
  const audio = new Uint8Array(totalBytes)
  let offset = 0
  for (const c of chunks) {
    audio.set(c, offset)
    offset += c.byteLength
  }
  const tDrainEnd = Date.now()
  console.log(`[stt-stream] drained ${totalBytes}B in ${tDrainEnd - tDrainStart}ms over ${chunks.length} chunks; first: ${earlyArrivals.map((a) => `+${a.at}ms/${a.bytes}B`).join(', ')}`)

  if (audio.byteLength === 0) {
    return err('BAD_REQUEST', 'Empty audio body', 400)
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    return err('BAD_REQUEST', 'Audio too large (max 50MB)', 413)
  }

  // ─── Forward to Groq (same as /v1/stt) ──────────────────────────
  const groqForm = new FormData()
  groqForm.append('file', new Blob([audio.buffer as ArrayBuffer], { type: 'audio/webm' }), 'audio.webm')
  groqForm.append('model', STT_MODEL)
  groqForm.append('response_format', 'json')
  groqForm.append('temperature', '0')
  groqForm.append('language', language)

  const tGroqStart = Date.now()
  const groqRes = await fetch(GROQ_STT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: groqForm,
  })
  const tGroqHeaders = Date.now()
  const groqTtfbMs = tGroqHeaders - tGroqStart

  if (!groqRes.ok) {
    const txt = await groqRes.text().catch(() => '')
    console.error('[pipeline] Stream STT Groq failed:', groqRes.status, txt.slice(0, 200))
    return err(
      groqRes.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR',
      `Groq STT returned ${groqRes.status}`,
      groqRes.status === 429 ? 429 : 502
    )
  }

  type GroqSTTResult = { text: string }
  const groqJson = (await groqRes.json()) as GroqSTTResult
  const tGroqBody = Date.now()
  const groqBodyMs = tGroqBody - tGroqHeaders
  const groqTotalMs = tGroqBody - tGroqStart
  const actualDuration = duration

  // ─── Cost + balance ────────────────────────────────────────────
  const costCents = sttCostCents(actualDuration)
  const balanceAfter = balanceBefore - costCents

  // ─── Fire-and-forget reconcile ─────────────────────────────────
  ctx.waitUntil(
    (async () => {
      await setBalance(env.USER_BALANCE, userId, balanceAfter)
      const result = await rpc<Array<{ usage_log_id: string; new_balance: number }>>(env, 'log_and_debit', {
        p_user_id: userId,
        p_amount_cents: costCents,
        p_call_type: 'stt',
        p_flow_type: flowType,
        p_provider: 'groq',
        p_model: STT_MODEL,
        p_prompt_tokens: 0,
        p_completion_tokens: 0,
        p_audio_duration_seconds: actualDuration,
        p_estimated_cost: rawGroqCostUsd('stt', { durationSeconds: actualDuration }),
        p_latency_ms: groqTotalMs,
        p_metadata: { model: STT_MODEL, duration_seconds: actualDuration, streaming: true },
      })
      const supabaseBalance = result?.[0]?.new_balance
      if (typeof supabaseBalance === 'number' && supabaseBalance !== balanceAfter) {
        await setBalance(env.USER_BALANCE, userId, supabaseBalance)
      }
    })().catch((e) => console.error('[pipeline] stream reconcile error:', e))
  )

  const tDone = Date.now()
  return json({
    ok: true,
    data: {
      text: groqJson.text,
      duration_seconds: actualDuration,
      model: STT_MODEL,
    },
    balance_cents: balanceAfter,
    cost_cents: costCents,
    engine: 'managed',
    timing_ms: {
      drain: tDrainEnd - tDrainStart,
      balance: tBalanceChecked - tEnter,
      groq_ttfb: groqTtfbMs,
      groq_body: groqBodyMs,
      groq_total: groqTotalMs,
      worker_total: tDone - tEnter,
      audio_bytes: audio.byteLength,
    },
  })
}

// ─── POST /v1/llm — chat completion ────────────────────────────

async function handleLLM(
  req: Request,
  env: PipelineEnv,
  ctx: ExecutionContext,
  userId: string
): Promise<Response> {
  const cl = parseInt(req.headers.get('Content-Length') || '0', 10)
  if (cl > MAX_LLM_BYTES) {
    return err('BAD_REQUEST', 'LLM request too large', 413)
  }

  let body: LLMRequest
  try {
    body = (await req.json()) as LLMRequest
  } catch {
    return err('BAD_REQUEST', 'Invalid JSON body', 400)
  }
  if (!body.messages?.length) {
    return err('BAD_REQUEST', 'messages required', 400)
  }

  // ─── Balance pre-check (small, but charge a minimum to deter spam) ───
  const balanceBefore = await getBalance(env, userId)
  // Reserve 5 cents up-front — actual cost charged after the call.
  if (balanceBefore < 5) {
    return err('INSUFFICIENT_BALANCE', 'Top up to use managed cloud', 402, {
      balance_cents: balanceBefore,
      top_up_url: TOP_UP_URL,
    })
  }

  // ─── Forward to Groq ──────────────────────────────────────────
  const groqBody = {
    model: body.model || LLM_MODEL,
    messages: body.messages,
    temperature: body.temperature ?? 0.2,
    max_tokens: body.max_tokens ?? 1024,
    stream: false, // explicit; we wait for token counts to charge correctly
  }

  const t0 = Date.now()
  const groqRes = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(groqBody),
  })
  const latencyMs = Date.now() - t0

  if (!groqRes.ok) {
    const txt = await groqRes.text().catch(() => '')
    console.error('[pipeline] Groq LLM failed:', groqRes.status, txt.slice(0, 200))
    return err(
      groqRes.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR',
      `Groq LLM returned ${groqRes.status}`,
      groqRes.status === 429 ? 429 : 502
    )
  }

  type GroqLLMResponse = {
    choices: Array<{ message: { content: string } }>
    usage: { prompt_tokens: number; completion_tokens: number }
    model: string
  }
  const groqJson = (await groqRes.json()) as GroqLLMResponse
  const text = groqJson.choices?.[0]?.message?.content ?? ''
  const pt = groqJson.usage?.prompt_tokens ?? 0
  const ct = groqJson.usage?.completion_tokens ?? 0

  const costCents = Math.max(llmCostCents(pt, ct), 1) // minimum 1 cent so we charge something
  const balanceAfter = await cacheDebit(env.USER_BALANCE, userId, costCents)

  ctx.waitUntil(
    (async () => {
      await setBalance(env.USER_BALANCE, userId, balanceAfter)
      const result = await rpc<Array<{ usage_log_id: string; new_balance: number }>>(env, 'log_and_debit', {
        p_user_id: userId,
        p_amount_cents: costCents,
        p_call_type: 'llm',
        p_flow_type: 'transform',
        p_provider: 'groq',
        p_model: groqJson.model || LLM_MODEL,
        p_prompt_tokens: pt,
        p_completion_tokens: ct,
        p_audio_duration_seconds: 0,
        p_estimated_cost: rawGroqCostUsd('llm', { promptTokens: pt, completionTokens: ct }),
        p_latency_ms: latencyMs,
        p_metadata: { model: groqJson.model || LLM_MODEL, prompt_tokens: pt, completion_tokens: ct },
      })
      const supabaseBalance = result?.[0]?.new_balance
      if (typeof supabaseBalance === 'number' && supabaseBalance !== balanceAfter) {
        await setBalance(env.USER_BALANCE, userId, supabaseBalance)
      }
    })().catch((e) => console.error('[pipeline] LLM reconcile error:', e))
  )

  return json({
    ok: true,
    data: {
      text,
      model: groqJson.model || LLM_MODEL,
      prompt_tokens: pt,
      completion_tokens: ct,
    },
    balance_cents: balanceAfter,
    cost_cents: costCents,
    engine: 'managed',
  })
}

// ─── Helpers ────────────────────────────────────────────────────

/** Very rough duration estimate when client didn't provide one. Audio at
 *  ~32 kbit/s opus → 1 second ≈ 4KB. Used only as a safety estimate for
 *  the balance pre-check; Groq returns the real duration. */
function estimateDurationFromBytes(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4000))
}
