#!/usr/bin/env node
// Mock Dodo webhook fixture — POSTs a synthetic, correctly-signed
// payment.succeeded (or other) event to the /webhook/dodo endpoint.
//
// Usage:
//   node scripts/mock-webhook.mjs \
//     --url http://localhost:8787/webhook/dodo \
//     --secret "whsec_<base64-of-your-test-secret>" \
//     --user-id "00000000-0000-0000-0000-000000000001" \
//     --amount-cents 1000 \
//     --event-type payment.succeeded
//
// Verifies the worker side end-to-end:
//   * signature verification accepts the synthetic payload
//   * process_topup_webhook RPC inserts a topup row (UNIQUE on event_id)
//   * wallet_ledger row + balance bump happen
//   * KV cache updates
//
// Idempotency:
//   The script accepts --event-id; with the same id you can re-send the
//   same payload and confirm the worker 200-ACKs without re-crediting
//   (is_duplicate=true path).
//
// Requires Node 18+ (built-in fetch + WebCrypto).

import { argv, exit } from 'node:process'
import { webcrypto } from 'node:crypto'
const subtle = webcrypto.subtle

// ─── arg parsing ────────────────────────────────────────────────

function parseArgs(args) {
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const val = args[i + 1]?.startsWith('--') || args[i + 1] === undefined ? 'true' : args[i + 1]
    out[key] = val
    if (val !== 'true') i++
  }
  return out
}

const args = parseArgs(argv.slice(2))
const url = args.url ?? 'http://localhost:8787/webhook/dodo'
const secret = args.secret ?? process.env.DODO_WEBHOOK_SECRET
const userId = args['user-id'] ?? '00000000-0000-0000-0000-000000000001'
const amountCents = Number(args['amount-cents'] ?? '1000')
const eventType = args['event-type'] ?? 'payment.succeeded'
const eventId = args['event-id'] ?? `evt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
const paymentId = args['payment-id'] ?? `pay_${Date.now()}`

if (!secret) {
  console.error('Missing --secret (or DODO_WEBHOOK_SECRET env var).')
  console.error('Set the test webhook secret you registered in the Dodo dashboard.')
  exit(2)
}

// ─── payload ────────────────────────────────────────────────────

const payload = {
  type: eventType,
  data: {
    payload_type: 'Payment',
    payment_id: paymentId,
    total_amount: amountCents,
    settlement_amount: amountCents,
    currency: 'USD',
    status: eventType === 'payment.succeeded' ? 'succeeded' : 'failed',
    customer: {
      email: 'test@unmute.app',
      customer_id: 'cus_test',
    },
    metadata: {
      user_id: userId,
      credit_cents: String(amountCents),
    },
  },
}

const rawBody = JSON.stringify(payload)
const timestamp = Math.floor(Date.now() / 1000)

// ─── sign (mirrors shared/dodoWebhook.ts signForTest) ───────────

function base64ToBuffer(b64) {
  const bin = Buffer.from(b64, 'base64')
  const buf = new ArrayBuffer(bin.length)
  new Uint8Array(buf).set(bin)
  return buf
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

function toBuffer(s) {
  const u8 = new TextEncoder().encode(s)
  const buf = new ArrayBuffer(u8.byteLength)
  new Uint8Array(buf).set(u8)
  return buf
}

async function sign() {
  const stripped = secret.startsWith('whsec_') ? secret.slice(6) : secret
  const key = await subtle.importKey(
    'raw',
    base64ToBuffer(stripped),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await subtle.sign(
    'HMAC',
    key,
    toBuffer(`${eventId}.${timestamp}.${rawBody}`),
  )
  return `v1,${bytesToBase64(new Uint8Array(mac))}`
}

// ─── send ───────────────────────────────────────────────────────

const signature = await sign()
const headers = {
  'Content-Type': 'application/json',
  'webhook-id': eventId,
  'webhook-timestamp': String(timestamp),
  'webhook-signature': signature,
}

console.log('→ POST', url)
console.log('  event-id:    ', eventId)
console.log('  event-type:  ', eventType)
console.log('  user-id:     ', userId)
console.log('  amount-cents:', amountCents)
console.log('  payment-id:  ', paymentId)

const startedAt = Date.now()
let res
try {
  res = await fetch(url, { method: 'POST', headers, body: rawBody })
} catch (e) {
  console.error('fetch failed:', e.message)
  console.error('Is the payments worker running? Try: wrangler dev')
  exit(1)
}

const elapsed = Date.now() - startedAt
const text = await res.text()
console.log(`← ${res.status} in ${elapsed}ms`)
console.log('  body:', text.slice(0, 200))

if (res.status === 200) {
  console.log('\nNext checks (run manually in your Supabase SQL editor):')
  console.log(
    `  select * from public.topups where provider_event_id = '${eventId}';`,
  )
  console.log(
    `  select balance_cents from public.profiles where id = '${userId}';`,
  )
  console.log(
    `  select * from public.wallet_ledger where user_id = '${userId}' order by created_at desc limit 5;`,
  )
  console.log('\nReplay (should ACK 200 + no-op — is_duplicate=true in the RPC):')
  console.log(
    `  node ${argv[1]} --url ${url} --secret '${secret}' --user-id ${userId} --amount-cents ${amountCents} --event-id ${eventId} --payment-id ${paymentId}`,
  )
} else {
  exit(1)
}
