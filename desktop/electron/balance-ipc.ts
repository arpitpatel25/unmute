// Balance state in the main process.
// Polls /v1/me periodically when signed in, broadcasts to all renderers.

import { ipcMain, BrowserWindow } from 'electron'
import { fetchMe } from './managed-client'

const POLL_INTERVAL_MS = 60_000 // 1 minute when active
let pollTimer: NodeJS.Timeout | null = null
let currentBalanceCents = 0
let topUpUrl = ''
let getTokenFn: (() => Promise<string | null>) | null = null

function broadcast(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('paywall:balance-updated', {
      balanceCents: currentBalanceCents,
      topUpUrl,
    })
  }
}

async function poll(): Promise<void> {
  if (!getTokenFn) return
  const token = await getTokenFn()
  if (!token) {
    currentBalanceCents = 0
    topUpUrl = ''
    broadcast()
    return
  }
  const me = await fetchMe(token)
  if (me) {
    currentBalanceCents = me.balanceCents
    topUpUrl = me.topUpUrl
    broadcast()
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
  topUpUrl = ''
  getTokenFn = null
  broadcast()
}

/** Updated after every successful managed call — the response carries the
 *  fresh balance so we don't need to wait for the next poll. */
export function updateBalanceFromResponse(balanceCents: number): void {
  currentBalanceCents = balanceCents
  broadcast()
}

export function registerBalanceIPC(): void {
  ipcMain.handle('paywall:get-balance', () => ({
    balanceCents: currentBalanceCents,
    topUpUrl,
  }))
  ipcMain.handle('paywall:refresh-balance', async () => {
    await poll()
    return { balanceCents: currentBalanceCents, topUpUrl }
  })
}
