// Main-process streaming uploader for managed-cloud STT.
//
// Architecture (per-chunk streaming, v2):
//   * Each chunk in chunked mode gets its OWN streaming POST. A long
//     dictation is N parallel streams: stream[0] for the first 0-20s,
//     stream[1] for 20-40s, etc. Each stream lives ≤20s — well under
//     Cloudflare's ~30s streaming POST limit (which killed our v1
//     single-long-stream approach).
//   * One stream at a time is the "active" stream (the one currently
//     receiving bytes from the renderer). When a chunk boundary fires,
//     the active stream is moved to "closed but awaiting response" and
//     a new stream becomes active for the next chunk.
//   * SessionManager awaits each chunk's stream response by index.
//
// Lifecycle:
//   openStream({chunkIndex: 0}) → active is stream 0
//   writeChunk(bytes)            → bytes go to active (stream 0)
//   closeStream()                → stream 0 closes; response promise stays
//                                  in the Map until someone awaits it
//   openStream({chunkIndex: 1}) → active becomes stream 1
//   ... etc ...
//   closeAndAwait(0)             → returns stream 0's transcript

import { getPaywallAccessToken, getPaywallEngineMode, getSTTLanguageForRequest, refreshAccessToken } from './paywall-glue'
import { updateBalanceFromResponse } from './balance-ipc'
import { paywallFetch } from './paywall-net'

interface StreamSession {
  chunkIndex: number
  controller: ReadableStreamDefaultController<Uint8Array>
  responsePromise: Promise<Response>
  abortController: AbortController
  tOpenedAt: number
  tClosedAt: number | null
  tBytesWritten: number
  writeCount: number
  closed: boolean
}

// Map: chunkIndex → StreamSession.  ≥1 streams may be in flight at once
// (one actively receiving bytes, others closed but awaiting response).
const sessions: Map<number, StreamSession> = new Map()
let activeChunkIndex: number | null = null

/**
 * Open a streaming POST for a specific chunk. Returns false if the user
 * isn't eligible for managed mode or has no token; caller should fall
 * back to the non-streaming path.
 */
export function openStream(opts: { flowType: string; chunkIndex?: number; estimatedDurationSeconds?: number }): boolean {
  const mode = getPaywallEngineMode()
  if (mode !== 'managed' && mode !== 'auto') return false
  const token = getPaywallAccessToken()
  if (!token) return false

  const chunkIndex = opts.chunkIndex ?? 0

  // If a stream for this chunkIndex already exists (e.g., renderer
  // re-opened due to MediaRecorder restart cycle), abort the old one.
  const existing = sessions.get(chunkIndex)
  if (existing && !existing.closed) {
    console.warn(`[paywall-stream] stream for chunk ${chunkIndex} exists — aborting old`)
    try { existing.abortController.abort() } catch { /* ignore */ }
    sessions.delete(chunkIndex)
  }

  const paramsInit: Record<string, string> = {
    flow_type: opts.flowType,
    duration_seconds: String(opts.estimatedDurationSeconds || 0),
    chunk_index: String(chunkIndex),
  }
  const lang = getSTTLanguageForRequest()
  if (lang) paramsInit.language = lang
  const params = new URLSearchParams(paramsInit)

  const abortController = new AbortController()
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
    },
  })

  const fetchInit: RequestInit & { duplex?: 'half' } = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    },
    body: stream,
    duplex: 'half',
    signal: abortController.signal,
  }
  const responsePromise = paywallFetch(`/v1/stt-stream?${params.toString()}`, fetchInit)

  sessions.set(chunkIndex, {
    chunkIndex,
    controller: controllerRef!,
    responsePromise,
    abortController,
    tOpenedAt: Date.now(),
    tClosedAt: null,
    tBytesWritten: 0,
    writeCount: 0,
    closed: false,
  })
  activeChunkIndex = chunkIndex
  console.log(`[paywall-stream] opened stream for chunk ${chunkIndex} (active sessions: ${sessions.size})`)
  return true
}

/** Write a chunk of audio bytes to the currently active stream. */
export function writeChunk(bytes: Uint8Array): void {
  if (activeChunkIndex === null) return
  const session = sessions.get(activeChunkIndex)
  if (!session || session.closed) return
  try {
    session.controller.enqueue(bytes)
    session.tBytesWritten += bytes.byteLength
    session.writeCount++
    if (session.writeCount === 1 || session.writeCount % 8 === 0) {
      const elapsed = Date.now() - session.tOpenedAt
      console.log(
        `[paywall-stream] chunk ${session.chunkIndex} write #${session.writeCount}: ${bytes.byteLength}B, total ${session.tBytesWritten}B at +${elapsed}ms`,
      )
    }
  } catch (e) {
    console.warn(`[paywall-stream] writeChunk failed (chunk ${activeChunkIndex}):`, (e as Error).message)
  }
}

/**
 * Close the currently active stream (no longer accepting writes).
 * The response promise stays in the Map until closeAndAwait is called.
 * After this returns, openStream() must be called again before more
 * writeChunk calls.
 */
export function closeActiveStream(): void {
  if (activeChunkIndex === null) return
  const session = sessions.get(activeChunkIndex)
  if (!session || session.closed) {
    activeChunkIndex = null
    return
  }
  session.closed = true
  session.tClosedAt = Date.now()
  try {
    session.controller.close()
  } catch { /* already closed */ }
  console.log(
    `[paywall-stream] closed chunk ${session.chunkIndex}: ${session.tBytesWritten}B over ${session.tClosedAt - session.tOpenedAt}ms; response awaitable`,
  )
  activeChunkIndex = null
}

// ─── Awaiting the response ──────────────────────────────────────

export interface StreamResult {
  text: string
  costCents: number
  balanceCents: number
  durationSeconds: number
  totalUploadBytes: number
  totalElapsedMs: number
  timing?: Record<string, number>
}

/**
 * Close the stream for chunkIndex (if not already closed) and await its
 * worker response. Returns null on failure (caller should fall back to
 * upload-based tryManagedSTT for this chunk).
 * Times out after timeoutMs to prevent SessionManager from hanging if
 * something goes wrong upstream.
 */
export async function closeAndAwait(chunkIndex: number, timeoutMs = 15_000): Promise<StreamResult | null> {
  const session = sessions.get(chunkIndex)
  if (!session) {
    console.warn(`[paywall-stream] closeAndAwait: no session for chunk ${chunkIndex}`)
    return null
  }

  // Ensure stream is closed (it usually already is by the time the caller
  // awaits it, but for safety we close again if still open)
  if (!session.closed) {
    if (activeChunkIndex === chunkIndex) {
      closeActiveStream()
    } else {
      session.closed = true
      session.tClosedAt = Date.now()
      try { session.controller.close() } catch { /* already closed */ }
    }
  }

  const tAwaitStart = Date.now()
  // Event-loop stall detector for this await window: if the JS event loop
  // stalls for >100ms between ticks, we want to know — that means response
  // bytes may have been sitting in the OS socket buffer while our code was
  // busy elsewhere (renderer IPC, GC, etc).
  const stallSamples: Array<{ at: number; stallMs: number }> = []
  let stallTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    /* heartbeat — actual stall is measured via the gap between expected
       fire time and actual fire time inside the callback */
  }, 50)
  let lastTick = Date.now()
  const stallChecker = setInterval(() => {
    const now = Date.now()
    const gap = now - lastTick
    if (gap > 150) {
      stallSamples.push({ at: now - tAwaitStart, stallMs: gap - 50 })
    }
    lastTick = now
  }, 50)

  try {
    // Race the response against a timeout to avoid hanging
    const timeoutPromise = new Promise<Response>((_, reject) =>
      setTimeout(() => reject(new Error('STREAM_TIMEOUT')), timeoutMs),
    )
    const res = await Promise.race([session.responsePromise, timeoutPromise])
    const tHeadersReceived = Date.now()

    if (res.status === 401) {
      console.log(`[paywall-stream] chunk ${chunkIndex} got 401 — refreshing token, caller will fall back`)
      void refreshAccessToken()
      sessions.delete(chunkIndex)
      if (stallTimer) clearInterval(stallTimer)
      clearInterval(stallChecker)
      return null
    }

    type Envelope = {
      ok: boolean
      data?: { text: string; duration_seconds: number; model: string }
      balance_cents?: number
      cost_cents?: number
      code?: string
      message?: string
      timing_ms?: Record<string, number>
    }
    const body = (await res.json()) as Envelope
    const tBodyParsed = Date.now()

    if (stallTimer) clearInterval(stallTimer)
    clearInterval(stallChecker)

    if (!res.ok || !body.ok) {
      // DIAG (offline-fallback hunt): full failure detail + edge ids, same as the
      // /v1/stt path, so both managed STT routes are equally observable.
      const ray = res.headers.get('cf-ray') ?? '-'
      const reqIdHdr = res.headers.get('x-request-id') ?? '-'
      console.warn(
        `[paywall-stream] ❌ chunk ${chunkIndex} FAILED — HTTP ${res.status} ${res.statusText}\n` +
        `  code=${body.code} message=${body.message}\n` +
        `  full envelope: ${JSON.stringify(body)}\n` +
        `  edge: cf-ray=${ray} x-request-id=${reqIdHdr}`
      )
      sessions.delete(chunkIndex)
      return null
    }

    if (body.balance_cents !== undefined) updateBalanceFromResponse(body.balance_cents)

    const tDone = tBodyParsed
    const totalElapsed = tDone - session.tOpenedAt
    const awaitTime = tDone - tAwaitStart
    const headersTime = tHeadersReceived - tAwaitStart
    const bodyReadTime = tBodyParsed - tHeadersReceived
    const w = body.timing_ms || {}
    const drainMs = (w.drain as number | undefined) ?? 0
    const groqTtfbMs = (w.groq_ttfb as number | undefined) ?? 0
    const groqBodyMs = (w.groq_body as number | undefined) ?? 0
    const groqTotal = (w.groq_total as number | undefined) ?? 0
    const workerTotal = (w.worker_total as number | undefined) ?? 0
    // Client-side "unexplained" gap: time between worker saying "done" and
    // us actually having the response. If this is large + stalls were
    // detected, the response was likely sitting in the OS buffer while our
    // event loop was busy. If large + no stalls, it was pure network down.
    const unexplained = Math.max(0, awaitTime - workerTotal)
    const totalStallMs = stallSamples.reduce((a, s) => a + s.stallMs, 0)
    const stallNote = stallSamples.length
      ? `event-loop stalls: ${stallSamples.length} spike(s), total ${totalStallMs}ms`
      : 'event-loop: no stalls'

    console.log(
      `[paywall-stream] chunk ${chunkIndex} TIMING — open→done: ${totalElapsed}ms\n` +
      `  ├─ stream alive (recording): ${session.tClosedAt ? session.tClosedAt - session.tOpenedAt : '?'}ms (${session.tBytesWritten}B uploaded)\n` +
      `  └─ close→response: ${awaitTime}ms\n` +
      `     ├─ close → headers arrived: ${headersTime}ms (= FIN up + worker_total + headers down)\n` +
      `     ├─ headers → body parsed:   ${bodyReadTime}ms (body down + JSON parse)\n` +
      `     ├─ server-reported worker_total: ${workerTotal}ms\n` +
      `     │    ├─ drain (CF buffer→worker):    ${drainMs}ms\n` +
      `     │    ├─ groq_ttfb (CF→Groq first byte): ${groqTtfbMs}ms\n` +
      `     │    └─ groq_body (Groq full response): ${groqBodyMs}ms\n` +
      `     ├─ network round-trip (close→headers − worker): ${Math.max(0, headersTime - workerTotal)}ms\n` +
      `     ├─ unexplained gap (await − worker): ${unexplained}ms\n` +
      `     └─ ${stallNote}`,
    )

    sessions.delete(chunkIndex)
    return {
      text: body.data!.text,
      costCents: body.cost_cents ?? 0,
      balanceCents: body.balance_cents ?? 0,
      durationSeconds: body.data!.duration_seconds,
      totalUploadBytes: session.tBytesWritten,
      totalElapsedMs: totalElapsed,
      timing: body.timing_ms,
    }
  } catch (e) {
    if (stallTimer) clearInterval(stallTimer)
    clearInterval(stallChecker)
    const isTimeout = (e as Error).message === 'STREAM_TIMEOUT'
    console.warn(
      `[paywall-stream] chunk ${chunkIndex} ${isTimeout ? 'TIMEOUT' : 'response error'}: ${(e as Error).message}`,
    )
    sessions.delete(chunkIndex)
    return null
  }
}

/** Cancel and discard ALL active sessions. Called on session cancel / Escape. */
export function closeImmediate(reason: string): void {
  for (const [idx, s] of sessions) {
    if (!s.closed) {
      console.log(`[paywall-stream] aborting chunk ${idx}: ${reason}`)
      try { s.abortController.abort() } catch { /* ignore */ }
    }
  }
  sessions.clear()
  activeChunkIndex = null
}

/** Whether ANY stream is currently active (receiving writes). */
export function isStreaming(): boolean {
  if (activeChunkIndex === null) return false
  const s = sessions.get(activeChunkIndex)
  return !!s && !s.closed
}

/** Whether a stream exists for chunkIndex (open or closed-awaiting). */
export function hasStreamForChunk(chunkIndex: number): boolean {
  return sessions.has(chunkIndex)
}
