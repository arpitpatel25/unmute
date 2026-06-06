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

import { getPaywallAccessToken, getPaywallEngineMode, refreshAccessToken } from './paywall-glue'
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

  const params = new URLSearchParams({
    flow_type: opts.flowType,
    language: 'en',
    duration_seconds: String(opts.estimatedDurationSeconds || 0),
    chunk_index: String(chunkIndex),
  })

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

  try {
    // Race the response against a timeout to avoid hanging
    const timeoutPromise = new Promise<Response>((_, reject) =>
      setTimeout(() => reject(new Error('STREAM_TIMEOUT')), timeoutMs),
    )
    const res = await Promise.race([session.responsePromise, timeoutPromise])

    if (res.status === 401) {
      console.log(`[paywall-stream] chunk ${chunkIndex} got 401 — refreshing token, caller will fall back`)
      void refreshAccessToken()
      sessions.delete(chunkIndex)
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

    if (!res.ok || !body.ok) {
      console.warn(`[paywall-stream] chunk ${chunkIndex} non-ok response: ${res.status} ${body.code} ${body.message}`)
      sessions.delete(chunkIndex)
      return null
    }

    if (body.balance_cents !== undefined) updateBalanceFromResponse(body.balance_cents)

    const tDone = Date.now()
    const totalElapsed = tDone - session.tOpenedAt
    const awaitTime = tDone - tAwaitStart
    const w = body.timing_ms || {}
    const groqTotal = (w.groq_total as number | undefined) ?? 0
    console.log(
      `[paywall-stream] chunk ${chunkIndex} TIMING — open→done: ${totalElapsed}ms\n` +
      `  ├─ stream alive (recording): ${session.tClosedAt ? session.tClosedAt - session.tOpenedAt : '?'}ms (${session.tBytesWritten}B uploaded)\n` +
      `  └─ close→response: ${awaitTime}ms (worker total ${w.worker_total || '?'}ms incl. Groq ${groqTotal}ms)`,
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
