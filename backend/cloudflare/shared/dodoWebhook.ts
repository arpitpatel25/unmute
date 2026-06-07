// Dodo Payments webhook signature verifier.
//
// Dodo follows the Standard Webhooks spec (standardwebhooks.com), same as Svix
// and Resend. Three headers per request:
//   * webhook-id        — unique event ID (dedupe key)
//   * webhook-timestamp — Unix seconds when Dodo signed the payload
//   * webhook-signature — space-separated list of "<version>,<base64>" pairs
//                          e.g. "v1,abc123== v1,def456=="
//
// The signing secret from Dodo's dashboard is base64-encoded with a `whsec_`
// prefix. To verify:
//   1. Strip `whsec_` and base64-decode to get the raw HMAC key.
//   2. Build the signed payload string: `${id}.${timestamp}.${rawBody}`.
//   3. HMAC-SHA256 with the raw key, base64-encode the result.
//   4. Constant-time compare against each `v1,...` value in the header
//      (any one match = valid; Dodo may rotate keys with overlap).
//   5. Reject if the timestamp is more than `REPLAY_WINDOW_SECONDS` off
//      from now (default 5 min — Standard Webhooks recommendation).
//
// Cloudflare Workers note: there is no Node `crypto`. We use Web Crypto
// (`crypto.subtle`) which is available in the Workers runtime without flags.

const REPLAY_WINDOW_SECONDS = 5 * 60

export interface VerifyOk {
  ok: true
  /** Stable event ID — use this as the dedupe key in webhook_events. */
  id: string
  /** Unix seconds the event was signed. */
  timestamp: number
  /** Parsed JSON body. */
  body: Record<string, unknown>
  /** The raw text body, in case you need to re-store it for audit. */
  raw: string
}

export interface VerifyErr {
  ok: false
  /** Machine-readable failure code — log this, never echo to caller. */
  code:
    | 'MISSING_HEADERS'
    | 'STALE_TIMESTAMP'
    | 'BAD_TIMESTAMP'
    | 'BAD_SIGNATURE_FORMAT'
    | 'BAD_SECRET_FORMAT'
    | 'SIGNATURE_MISMATCH'
    | 'INVALID_JSON'
  /** Human-readable detail, safe to log but NOT to return to Dodo or the user. */
  detail: string
}

/**
 * Verify a Dodo webhook request and return its event payload.
 *
 * Pass the raw body text — do NOT call `request.json()` first. Cloudflare
 * Workers consume the body on first read; if the caller has already parsed
 * JSON, whitespace normalization will break HMAC. Always: read once with
 * `await request.text()`, pass here, then `JSON.parse` from the result.
 */
export async function verifyDodoWebhook(
  headers: Headers,
  rawBody: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VerifyOk | VerifyErr> {
  const id = headers.get('webhook-id')
  const tsRaw = headers.get('webhook-timestamp')
  const sigHeader = headers.get('webhook-signature')
  if (!id || !tsRaw || !sigHeader) {
    return { ok: false, code: 'MISSING_HEADERS', detail: 'webhook-{id,timestamp,signature} required' }
  }

  const ts = Number(tsRaw)
  if (!Number.isFinite(ts) || ts <= 0) {
    return { ok: false, code: 'BAD_TIMESTAMP', detail: `not a number: ${tsRaw}` }
  }
  if (Math.abs(nowSeconds - ts) > REPLAY_WINDOW_SECONDS) {
    return {
      ok: false,
      code: 'STALE_TIMESTAMP',
      detail: `delta ${nowSeconds - ts}s outside ±${REPLAY_WINDOW_SECONDS}s replay window`,
    }
  }

  const rawSecret = decodeSecret(secret)
  if (!rawSecret) {
    return { ok: false, code: 'BAD_SECRET_FORMAT', detail: 'secret not base64 or missing whsec_ prefix' }
  }

  const key = await crypto.subtle.importKey(
    'raw',
    rawSecret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const macBuf = await crypto.subtle.sign(
    'HMAC',
    key,
    toBuffer(`${id}.${ts}.${rawBody}`),
  )
  const expected = bytesToBase64(new Uint8Array(macBuf))

  // Header is space-separated. Accept any matching v1 signature.
  const candidates = sigHeader.split(' ')
  if (candidates.length === 0) {
    return { ok: false, code: 'BAD_SIGNATURE_FORMAT', detail: 'empty signature header' }
  }
  let anyV1Present = false
  for (const cand of candidates) {
    if (!cand.startsWith('v1,')) continue
    anyV1Present = true
    if (timingSafeEqual(cand.slice(3), expected)) {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>
      } catch (e) {
        return { ok: false, code: 'INVALID_JSON', detail: (e as Error).message }
      }
      return { ok: true, id, timestamp: ts, body, raw: rawBody }
    }
  }
  if (!anyV1Present) {
    return { ok: false, code: 'BAD_SIGNATURE_FORMAT', detail: 'no v1 signature in header' }
  }
  return { ok: false, code: 'SIGNATURE_MISMATCH', detail: 'no signature matched expected' }
}

// ─── helpers ────────────────────────────────────────────────────

/** Strip `whsec_` and base64-decode. Returns null on malformed input.
 *  Returns ArrayBuffer (not Uint8Array) so crypto.subtle accepts it
 *  without the TS5 ArrayBufferLike-vs-ArrayBuffer dance. */
function decodeSecret(secret: string): ArrayBuffer | null {
  if (!secret) return null
  const trimmed = secret.startsWith('whsec_') ? secret.slice(6) : secret
  try {
    return base64ToBuffer(trimmed)
  } catch {
    return null
  }
}

/** Encode a UTF-8 string to a fresh ArrayBuffer. Avoids the
 *  Uint8Array→BufferSource type friction at crypto.subtle call sites. */
function toBuffer(s: string): ArrayBuffer {
  const view = new TextEncoder().encode(s)
  // Copy into a fresh ArrayBuffer so the runtime view is concrete (not
  // shared) and TS is happy passing it as BufferSource.
  const buf = new ArrayBuffer(view.byteLength)
  new Uint8Array(buf).set(view)
  return buf
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const buf = new ArrayBuffer(bin.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i)
  return buf
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/** Constant-time string compare. Returns false on length mismatch without
 *  early-exit timing leak (still leaks length, which is acceptable here). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ─── Test fixture generator (for the mock harness in task 12) ───
// Convenience for tests: sign a payload with the same algorithm Dodo uses, so
// the mock harness can fire a synthetic webhook against the live verifier.

export async function signForTest(
  body: string,
  secret: string,
  id: string,
  timestampSeconds: number,
): Promise<string> {
  const rawSecret = decodeSecret(secret)
  if (!rawSecret) throw new Error('bad secret for signing')
  const key = await crypto.subtle.importKey(
    'raw',
    rawSecret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const macBuf = await crypto.subtle.sign(
    'HMAC',
    key,
    toBuffer(`${id}.${timestampSeconds}.${body}`),
  )
  return `v1,${bytesToBase64(new Uint8Array(macBuf))}`
}
