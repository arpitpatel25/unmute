// Balance state in the main process.
//
// NOTE (subscription migration): pay-per-use balance is no longer surfaced in
// the UI — provider-router gates on subActive and BalancePill reads the
// subscription status, not a cents balance. The renderer-facing balance
// plumbing (paywall:get-balance / paywall:refresh-balance / the
// paywall:balance-updated broadcast) was removed as dead code.
//
// What remains is the lightweight /v1/me poll: it keeps the cached cents value
// fresh for any future internal use and, importantly, doubles as a periodic
// authenticated ping. The cached value is also updated inline from successful
// managed responses via updateBalanceFromResponse (cheaper than waiting for the
// next poll). Nothing broadcasts to the renderer anymore.

import { fetchMe } from './managed-client'

const POLL_INTERVAL_MS = 60_000 // 1 minute when active
let pollTimer: NodeJS.Timeout | null = null
let currentBalanceCents = 0
let getTokenFn: (() => Promise<string | null>) | null = null

async function poll(): Promise<void> {
  if (!getTokenFn) return
  const token = await getTokenFn()
  if (!token) {
    currentBalanceCents = 0
    return
  }
  const me = await fetchMe(token)
  if (me) {
    currentBalanceCents = me.balanceCents
  }
}

export function startBalancePolling(getToken: () => Promise<string | null>): void {
  getTokenFn = getToken
  if (pollTimer) clearInterval(pollTimer)
  // Immediate first poll, then on interval
  void poll()
  pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS)
}

/** Force-refresh balance now, without waiting for the next tick.
 *  Called from paywall-glue the moment a session arrives. */
export async function refreshBalanceNow(): Promise<void> {
  await poll()
}

export function stopBalancePolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  currentBalanceCents = 0
  getTokenFn = null
}

/** Updated after every successful managed call — the response carries the
 *  fresh balance so we don't need to wait for the next poll. */
export function updateBalanceFromResponse(balanceCents: number): void {
  currentBalanceCents = balanceCents
}
