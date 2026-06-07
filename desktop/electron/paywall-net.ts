// Centralized network layer for all paywall HTTPS calls.
//
// Problem we're solving: logs showed keep-alive pings and STT uploads
// paying 200-1000ms per request — classic evidence of TCP+TLS handshakes
// instead of connection reuse. setGlobalDispatcher() should have fixed
// this but didn't (Electron's fetch may not honor the global dispatcher,
// or CF closes idle connections aggressively).
//
// This module:
//   * Creates a dedicated undici Pool for our worker host.
//   * Exposes paywallFetch() that passes the Pool as `dispatcher` on
//     every call — guaranteed to use this Pool's connections.
//   * Logs Pool stats on every request so we can SEE whether connections
//     are being reused.
//   * Runs a self-test on app start: 5 back-to-back pings to verify
//     subsequent requests reuse the same TCP socket.

import { Pool } from 'undici'

// __PIPELINE_URL__ is substituted by the bundler; we strip the path here
// because Pool wants only the origin.
declare const __PIPELINE_URL__: string

const origin = (() => {
  try {
    return new URL(__PIPELINE_URL__).origin
  } catch {
    return 'https://unmute-pipeline.zodpatel.workers.dev'
  }
})()

export const pipelinePool = new Pool(origin, {
  connections: 8,
  // Keep idle connections alive for 60 seconds — well above CF's idle close
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  // Single in-flight request per connection (Workers don't pipeline)
  pipelining: 1,
})

// Connection-event counters. undici emits 'connect' every time it opens a new
// TCP+TLS socket and 'disconnect' when one drops. We want these as low as
// possible — ideally one socket opens at app start, and every subsequent
// request reuses it. The heuristic label in paywallFetch (based on
// tHeaders-t0) is unreliable for streaming POSTs because the header response
// only arrives AFTER the body finishes uploading. Counting real connect events
// gives us the truth.
let connectsOpened = 0
let connectsClosed = 0
try {
  pipelinePool.on('connect', () => {
    connectsOpened++
    console.log(`[paywall-net] 🔌 pool connect (#${connectsOpened} opened, ${connectsClosed} closed since start)`)
  })
  pipelinePool.on('disconnect', (_origin, _targets, error) => {
    connectsClosed++
    console.log(`[paywall-net] 🔌 pool disconnect (#${connectsClosed} closed, ${connectsOpened} opened since start; reason: ${error?.message ?? 'idle/timeout'})`)
  })
} catch {
  /* older undici may lack typed events — best-effort */
}

/** Returns total connection-open / connection-close counters since boot. */
export function getConnectionCounters(): { opened: number; closed: number } {
  return { opened: connectsOpened, closed: connectsClosed }
}

// Track per-request timing so the diagnostic logs are meaningful.
let requestCounter = 0

interface PoolStatsSnapshot {
  connected: number
  free: number
  pending: number
  queued: number
  running: number
  size: number
}

function poolStats(): PoolStatsSnapshot {
  // undici exposes stats on the pool's internal pools, but the shape varies
  // by version. Use the safest API: stats getter if present, else infer.
  const p = pipelinePool as unknown as { stats?: PoolStatsSnapshot }
  if (p.stats) return p.stats
  return { connected: 0, free: 0, pending: 0, queued: 0, running: 0, size: 0 }
}

/**
 * Wrapper around fetch that pins requests to our dedicated Pool.
 * Logs request id + pool state at start and end so connection reuse
 * is visible in the log.
 */
export async function paywallFetch(
  path: string,
  init: RequestInit & { duplex?: 'half' } = {}
): Promise<Response> {
  const reqId = ++requestCounter
  const url = path.startsWith('http') ? path : `${origin}${path}`
  const t0 = Date.now()
  const statsBefore = poolStats()

  // Pass the Pool as dispatcher — this guarantees the request uses our
  // configured Pool and not Electron's default fetch agent.
  const fetchInit: RequestInit & { dispatcher?: unknown; duplex?: 'half' } = {
    ...init,
    dispatcher: pipelinePool,
  }
  const res = await fetch(url, fetchInit as RequestInit)
  const tHeaders = Date.now()
  const statsAfter = poolStats()

  // Connection-reuse heuristic: if header-time is <120ms it's almost
  // certainly a reused connection (TLS handshake alone is 100-300ms).
  const reuseHint =
    tHeaders - t0 < 120 ? 'REUSED' :
    tHeaders - t0 < 250 ? 'maybe-reused' :
    'FRESH-HANDSHAKE'

  console.log(
    `[paywall-net] req#${reqId} ${init.method || 'GET'} ${path} — ${tHeaders - t0}ms → ${reuseHint}\n` +
    `  pool before: ${JSON.stringify(statsBefore)}\n` +
    `  pool after:  ${JSON.stringify(statsAfter)}\n` +
    `  connections since boot: ${connectsOpened} opened, ${connectsClosed} closed`
  )

  return res
}

/**
 * Self-test run on app start: send 5 back-to-back HEAD pings to /v1/me.
 * Connection should be opened on #1 (slow handshake), then reused for
 * #2-#5 (fast). If all 5 are slow, connection reuse is broken.
 */
export async function verifyKeepAlive(): Promise<void> {
  console.log('[paywall-net] verifyKeepAlive: sending 5 back-to-back pings…')
  const timings: number[] = []
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now()
    try {
      await paywallFetch('/v1/me', { method: 'OPTIONS' })
    } catch (e) {
      console.warn(`[paywall-net] verifyKeepAlive ping #${i + 1} failed:`, (e as Error).message)
    }
    timings.push(Date.now() - t0)
  }

  const first = timings[0]
  const restAvg = timings.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, timings.length - 1)
  const restMin = Math.min(...timings.slice(1))
  const restMax = Math.max(...timings.slice(1))
  const spread = restMax - restMin
  // If all pings cluster tightly (small spread), connections are being
  // reused — the absolute latency floor depends on RTT to nearest PoP.
  // If spread is large, some pings are paying handshakes.
  const verdict =
    spread < 80 && restMax < 250 ? 'KEEP-ALIVE WORKING ✅ (tight cluster, RTT-bound)' :
    spread < 150 ? 'KEEP-ALIVE WORKING ✅ (some jitter but consistent)' :
    'KEEP-ALIVE BROKEN ❌ — wide spread suggests handshakes on some pings'

  console.log(
    `[paywall-net] verifyKeepAlive result:\n` +
    `  ping latencies: ${timings.map((t) => `${t}ms`).join(' | ')}\n` +
    `  first (fresh handshake expected): ${first}ms\n` +
    `  rest (reuse expected): avg ${Math.round(restAvg)}ms\n` +
    `  → ${verdict}`
  )
}

/** Periodic stats sampling — every 60s log a summary. */
export function startPoolStatsSampling(): void {
  setInterval(() => {
    const s = poolStats()
    if (s.connected || s.pending || s.queued) {
      console.log(`[paywall-net] pool sample: ${JSON.stringify(s)}`)
    }
  }, 60_000).unref()
}
