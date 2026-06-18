// Managed-route intercept for sessionManager.
//
// sessionManager calls tryManagedSTT/tryManagedLLM BEFORE its existing
// BYOK/local routing. If the user has selected Managed (or Auto + has
// balance + signed in), the call goes through our pipeline worker.
// Otherwise these return null and the caller falls through to its
// existing logic.

import { getPaywallAccessToken, getPaywallEngineMode, getSTTLanguageForRequest, refreshAccessToken } from './paywall-glue'
// keyStore lives in the OSS engine; after wire_paywall we sit in
// engine/electron/paywall/, so OSS-engine siblings need `../`.
import { hasApiKey } from '../keyStore'
import { updateBalanceFromResponse } from './balance-ipc'
import { paywallFetch } from './paywall-net'

// Pipeline URL — bundler injects __PIPELINE_URL__ via electron.vite.config.ts
declare const __PIPELINE_URL__: string

// Track if we just fell back from managed → BYOK/local so we can show the banner
let fellBackThisSession = false

export interface ManagedSTTResult {
  text: string
  durationSeconds: number
  costCents: number
  engine: 'managed'
}

export interface ManagedLLMResult {
  text: string
  costCents: number
  engine: 'managed'
}

/** Decide if managed should be tried for this call. */
function shouldTryManaged(): boolean {
  const mode = getPaywallEngineMode()
  const token = getPaywallAccessToken()
  if (mode === 'managed') return !!token
  if (mode === 'auto') return !!token // try managed first; fall back on failure
  return false // 'byok' or 'local' → never use managed
}

/** Decide if we should fall through to existing OSS routing on managed failure. */
function shouldFallThrough(): boolean {
  const mode = getPaywallEngineMode()
  // 'managed' strict mode → don't fall through, surface the error
  // 'auto' → fall through to BYOK/Local
  return mode === 'auto'
}

/** Notify the renderer that we fell back from managed → local. */
function notifyFellBack(): void {
  if (fellBackThisSession) return
  fellBackThisSession = true
  // Reset for next session
  setTimeout(() => { fellBackThisSession = false }, 60_000)
  try {
    const { BrowserWindow } = require('electron')
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('paywall:fell-back-to-local', 'https://unmute.app/topup')
    }
  } catch { /* ignore */ }
}

/**
 * Try the managed STT path. Returns the transcript+cost on success, or
 * null if we should fall through to the existing OSS routing.
 * Throws if mode is strict 'managed' and the call fails (so the caller
 * surfaces an error rather than silently falling back).
 */
export async function tryManagedSTT(
  audio: Buffer,
  durationSeconds: number,
  flowType: 'dictation' | 'transform' | 'quote' | 'context' | 'instruction' = 'dictation',
  signal?: AbortSignal,
): Promise<ManagedSTTResult | null> {
  if (!shouldTryManaged()) return null

  const token = getPaywallAccessToken()
  if (!token) return null

  try {
    const tFormStart = Date.now()
    const form = new FormData()
    form.append('file', new Blob([audio], { type: 'audio/webm' }), 'audio.webm')
    form.append('duration_seconds', String(durationSeconds))
    // Language is read from settings. null = auto-detect (no field sent —
    // Whisper detects across all 99 supported languages on its own).
    const lang = getSTTLanguageForRequest()
    if (lang) form.append('language', lang)
    form.append('flow_type', flowType)
    const tFormEnd = Date.now()

    // DIAG (offline-fallback hunt): is the audio we're uploading a VALID webm?
    // A Groq 400 usually means the file couldn't be decoded. webm/Matroska starts
    // with the EBML magic 1A 45 DF A3. Log the first bytes + mime so we can tell a
    // good recording from a malformed/empty one across machines.
    const head = Array.from(audio.subarray(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const isWebm = audio.length >= 4 && audio[0] === 0x1a && audio[1] === 0x45 && audio[2] === 0xdf && audio[3] === 0xa3
    console.log(
      `[paywall-route] STT request — audio ${audio.length}B (${(audio.length / 1024).toFixed(1)}KB) for ${durationSeconds}s, ` +
      `mime=audio/webm, lang=${lang ?? 'auto'}, flow=${flowType}, FormData built in ${tFormEnd - tFormStart}ms\n` +
      `  audio head bytes: [${head}] → ${isWebm ? 'valid webm EBML header ✓' : 'NOT a webm EBML header ✗ (Groq will 400)'}`
    )

    const tFetchStart = Date.now()
    let currentToken = token
    let res = await paywallFetch('/v1/stt', {
      method: 'POST',
      headers: { Authorization: `Bearer ${currentToken}` },
      body: form,
      signal,
    })
    // ─── Retry on 401 (token expired) — refresh + retry once ──────
    if (res.status === 401) {
      console.log('[paywall-route] STT got 401, refreshing token and retrying')
      const refreshed = await refreshAccessToken()
      if (refreshed) {
        const fresh = getPaywallAccessToken()
        if (fresh) {
          currentToken = fresh
          // FormData can't be re-used after consumption; rebuild it
          const retryForm = new FormData()
          retryForm.append('file', new Blob([opts.audio], { type: 'audio/webm' }), 'audio.webm')
          retryForm.append('duration_seconds', String(opts.durationSeconds))
          if (opts.language) retryForm.append('language', opts.language)
          if (opts.flowType) retryForm.append('flow_type', opts.flowType)
          res = await fetch(`${__PIPELINE_URL__}/v1/stt`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${currentToken}` },
            body: retryForm,
            signal,
          })
        }
      }
    }
    const tFetchHeaders = Date.now()
    // body parse happens below
    const tFetchEnd = Date.now()
    void tFetchHeaders

    type Envelope = {
      ok: boolean
      data?: { text: string; duration_seconds: number; model: string }
      balance_cents?: number
      cost_cents?: number
      code?: string
      message?: string
      timing_ms?: { parse: number; balance: number; groq_ttfb: number; groq_body: number; groq_total: number; worker_total: number }
    }
    const body = (await res.json()) as Envelope

    if (!res.ok || !body.ok) {
      // DIAG (offline-fallback hunt): dump EVERYTHING about the failure so we can
      // see exactly why the worker/Groq rejected this request — full envelope +
      // the edge request-ids (cf-ray / x-request-id) to correlate with worker logs.
      const ray = res.headers.get('cf-ray') ?? '-'
      const reqIdHdr = res.headers.get('x-request-id') ?? res.headers.get('x-amzn-requestid') ?? '-'
      console.warn(
        `[paywall-route] ❌ managed STT FAILED — HTTP ${res.status} ${res.statusText}\n` +
        `  url: ${__PIPELINE_URL__}/v1/stt\n` +
        `  code=${body.code} message=${body.message}\n` +
        `  full envelope: ${JSON.stringify(body)}\n` +
        `  edge: cf-ray=${ray} x-request-id=${reqIdHdr} content-type=${res.headers.get('content-type') ?? '-'}\n` +
        `  → falling through to ${shouldFallThrough() ? 'LOCAL (offline model)' : 'ERROR (no fallback)'}`
      )
      if (body.balance_cents !== undefined) updateBalanceFromResponse(body.balance_cents)
      if (shouldFallThrough()) {
        notifyFellBack()
        return null
      }
      throw new Error(`Managed STT failed: ${body.message || res.status}`)
    }

    if (body.balance_cents !== undefined) updateBalanceFromResponse(body.balance_cents)

    // ─── Latency breakdown ───────────────────────────────────────
    // Total client-observed = network up + worker + network down
    // Worker breakdown comes from body.timing_ms
    const tBodyParseEnd = Date.now()
    const clientTotal = tBodyParseEnd - tFetchStart
    const headersMs = tFetchHeaders - tFetchStart
    const bodyMs = tBodyParseEnd - tFetchHeaders
    const w = body.timing_ms ?? { parse: 0, balance: 0, groq_ttfb: 0, groq_body: 0, groq_total: 0, worker_total: 0 }
    const network = Math.max(0, clientTotal - w.worker_total)
    const workerOverhead = Math.max(0, w.worker_total - w.groq_total - w.parse - w.balance)
    const uploadKBs = audio.length / 1024
    console.log(
      `[paywall-route] STT TIMING — ${uploadKBs.toFixed(1)}KB upload | total ${clientTotal}ms\n` +
      `  ├─ client→edge headers: ${headersMs}ms (upload + TTFB)\n` +
      `  ├─ body download+parse: ${bodyMs}ms\n` +
      `  ├─ network total (devicе↔edge): ${network}ms\n` +
      `  └─ worker total: ${w.worker_total}ms\n` +
      `       ├─ parse FormData: ${w.parse}ms\n` +
      `       ├─ balance KV: ${w.balance}ms\n` +
      `       ├─ Groq round-trip: ${w.groq_total}ms (TTFB ${w.groq_ttfb}ms + body ${w.groq_body}ms)\n` +
      `       └─ worker overhead: ${workerOverhead}ms`
    )

    return {
      text: body.data!.text,
      durationSeconds: body.data!.duration_seconds,
      costCents: body.cost_cents ?? 0,
      engine: 'managed',
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    console.warn('[paywall-route] managed STT threw:', e)
    if (shouldFallThrough()) {
      notifyFellBack()
      return null
    }
    throw e
  }
}

/**
 * Try the managed LLM path. messages is the full chat array (system + user).
 */
export async function tryManagedLLM(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options: { temperature?: number; maxTokens?: number } = {},
  signal?: AbortSignal,
): Promise<ManagedLLMResult | null> {
  if (!shouldTryManaged()) return null

  const token = getPaywallAccessToken()
  if (!token) return null

  try {
    const res = await paywallFetch('/v1/llm', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
      }),
      signal,
    })

    type Envelope = {
      ok: boolean
      data?: { text: string; model: string; prompt_tokens: number; completion_tokens: number }
      balance_cents?: number
      cost_cents?: number
      code?: string
      message?: string
    }
    const body = (await res.json()) as Envelope

    if (!res.ok || !body.ok) {
      console.warn('[paywall-route] managed LLM failed:', res.status, body.code, body.message)
      if (body.balance_cents !== undefined) updateBalanceFromResponse(body.balance_cents)
      if (shouldFallThrough()) {
        notifyFellBack()
        return null
      }
      throw new Error(`Managed LLM failed: ${body.message || res.status}`)
    }

    if (body.balance_cents !== undefined) updateBalanceFromResponse(body.balance_cents)
    return {
      text: body.data!.text,
      costCents: body.cost_cents ?? 0,
      engine: 'managed',
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    console.warn('[paywall-route] managed LLM threw:', e)
    if (shouldFallThrough()) {
      notifyFellBack()
      return null
    }
    throw e
  }
}

/** Used by sessionManager to decide if BYOK should be skipped in favor of local. */
export function shouldSkipByok(): boolean {
  const mode = getPaywallEngineMode()
  if (mode === 'local') return true
  if (mode === 'byok') return false
  if (mode === 'managed') return true // strict managed → no BYOK
  // auto: skip BYOK if user has no key
  return !hasApiKey()
}
