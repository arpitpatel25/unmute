// Unmute Remote — floating task overlay window (DECIDED: replaces OS notifications).
//
// A second always-on-top, transparent, cross-Space window (separate from the
// dictation pill). It AUTO-PRESENTS when a task enters a terminal/attention
// state (done / failed / needs-user / stuck) so the user sees the result/answer
// WHERE THEY ARE — zero context switch — and answers needs-user in place (by
// voice via the Remote key, or by typing into the task's terminal).
//
// Rules (agreed with the owner):
//   * Auto = present only. NEVER auto-dismiss — dismissal is always a user action
//     (Escape when focused, or the ✕).
//   * Shown with showInactive() so it never steals focus from what the user is
//     doing; they click it to interact, which focuses it.
//   * A setting (overlayAutoPresent) turns the auto-popup off entirely.
//
// Electron glue (BrowserWindow/screen), so — like init.ts — not unit-tested.

import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { createLogger } from './log'

const log = createLogger('overlay')

let overlayWindow: BrowserWindow | null = null

/** Right-edge bounds: a tall, narrow panel on the active display's right side. */
function overlayBounds(): { x: number; y: number; width: number; height: number } {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const wa = display.workArea
  const width = 400
  const margin = 16
  const height = Math.min(720, Math.round(wa.height * 0.7))
  return {
    width,
    height,
    x: wa.x + wa.width - width - margin,
    y: wa.y + Math.round((wa.height - height) / 2),
  }
}

/** Create the overlay window (hidden). Idempotent. */
export function createOverlayWindow(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow
  const { x, y, width, height } = overlayBounds()

  overlayWindow = new BrowserWindow({
    width, height, x, y,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    // Focusable so the user can click a card / type an answer — but we present
    // with showInactive() so it never grabs focus on its own.
    focusable: true,
    type: 'panel',
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 'screen-saver' level sits ABOVE full-screen apps (the 'floating' level sat
  // below them, so the overlay vanished over fullscreen video/apps). Combined
  // with visibleOnFullScreen (the fullScreenAuxiliary collection behavior), this
  // is the standard recipe for an overlay that stays pinned over EVERYTHING,
  // including full-screen Spaces. (DRM players / exclusive-fullscreen games can
  // still block any overlay — an OS limit, not ours.)
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWindow.setFullScreenable(false)

  if (process.env.ELECTRON_RENDERER_URL) {
    void overlayWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/overlay`)
  } else {
    void overlayWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/overlay' })
  }

  overlayWindow.on('closed', () => { overlayWindow = null })
  log.event('overlay-window-created', {})
  return overlayWindow
}

/** Present the overlay (without stealing focus) and tell it which task to expand. */
export function presentOverlay(taskId: string): void {
  const win = createOverlayWindow()
  win.setBounds(overlayBounds()) // re-anchor to the active display
  win.webContents.send('remote:overlay-focus', { taskId })
  if (!win.isVisible()) win.showInactive() // appear WITHOUT taking focus
  log.event('overlay-presented', { taskId })
}

/** Hide the overlay (user-triggered dismiss). The task stays in the app. */
export function dismissOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayWindow.hide()
    log.event('overlay-dismissed', {})
  }
}

export function isOverlayVisible(): boolean {
  return !!overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()
}
