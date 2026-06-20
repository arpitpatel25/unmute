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

import { app, BrowserWindow, screen, globalShortcut } from 'electron'
import { join } from 'node:path'
import { createLogger } from './log'

const log = createLogger('overlay')

let overlayWindow: BrowserWindow | null = null
// Installed once: re-pin the overlay when the app regains focus. macOS can drop
// the all-Spaces collection behavior / level on app-deactivation, and nothing
// else re-asserts it between presents — so without this the panel can silently
// slip off after you tab away and back. (Cross-Space persistence while we're in
// the BACKGROUND relies on the stable collection behavior — skipTransformProcessType
// on both windows — since macOS gives Electron no Space-change event to hook.)
let reassertInstalled = false
// Whether WE currently hold the global Escape shortcut (vs the engine, which
// grabs it during a dictation/remote capture so its cancel wins). We only take
// Escape while the overlay is visible AND no capture owns it.
let escHeldByOverlay = false

/** Take global Escape → dismiss (only if no one else — i.e. a capture — holds it). */
function grabEscape(): void {
  if (escHeldByOverlay) return
  try {
    if (!globalShortcut.isRegistered('Escape')) {
      escHeldByOverlay = globalShortcut.register('Escape', () => dismissOverlay())
    }
  } catch (e) { log.warn('grabEscape failed', { error: (e as Error).message }) }
}

function releaseEscape(): void {
  if (!escHeldByOverlay) return
  try { globalShortcut.unregister('Escape') } catch { /* best-effort */ }
  escHeldByOverlay = false
}

/** Called when a voice capture starts: yield Escape so the capture's cancel wins
 *  (capture-first priority). The overlay stays visible. */
export function pauseOverlayEscape(): void { releaseEscape() }

/** Called when a capture ends: reclaim Escape if the overlay is still up. */
export function resumeOverlayEscape(): void { if (isOverlayVisible()) grabEscape() }

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

/** Re-assert the level + all-Spaces flags. macOS drops these on show/hide and on
 *  app-deactivation; re-applying keeps the panel pinned over everything, on every
 *  Space. No-op if the window is gone. */
function reassertPinning(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.setAlwaysOnTop(true, 'screen-saver')
}

/** Install (once) an app-focus hook that re-pins the overlay whenever we regain
 *  focus — covers the case where macOS dropped the behavior while we were in the
 *  background (e.g. you were in a terminal and the panel slipped off). */
function installReassertHook(): void {
  if (reassertInstalled) return
  reassertInstalled = true
  app.on('browser-window-focus', () => {
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
      reassertPinning(overlayWindow)
    }
  })
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
    // Accept the FIRST click even when the window isn't active, so the ✕ / a card
    // responds immediately instead of the first click only raising the window.
    acceptFirstMouse: true,
    type: 'panel',
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Pin over EVERYTHING, on every Space: 'screen-saver' level (above full-screen
  // apps — 'floating' sat below them and vanished over fullscreen/terminal) +
  // all-Spaces + visibleOnFullScreen + skipTransformProcessType. The last flag
  // stops Electron from flipping the process type when it joins all Spaces — that
  // transform gave the window a "home" Space (flicker-in-then-vanish on Space
  // swipes) and, being app-wide, destabilised the pill too. (DRM players /
  // exclusive-fullscreen games can still block any overlay — an OS limit, not ours.)
  reassertPinning(overlayWindow)
  overlayWindow.setFullScreenable(false)
  installReassertHook()

  if (process.env.ELECTRON_RENDERER_URL) {
    void overlayWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/overlay`)
  } else {
    void overlayWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/overlay' })
  }

  overlayWindow.on('closed', () => { releaseEscape(); overlayWindow = null })
  log.event('overlay-window-created', {})
  return overlayWindow
}

/** Present the overlay (without stealing focus) and tell it which task to expand. */
export function presentOverlay(taskId: string): void {
  const win = createOverlayWindow()
  win.setBounds(overlayBounds()) // re-anchor to the active display
  win.webContents.send('remote:overlay-focus', { taskId })
  if (!win.isVisible()) win.showInactive() // appear WITHOUT taking focus
  // Re-assert the all-Spaces + level flags on every present — macOS can drop the
  // collection behavior after a show/hide, which is what let it slip back to a
  // single Space. Re-applying here keeps it omnipresent.
  reassertPinning(win)
  // Escape dismisses even though the window is unfocused (we show it inactive) —
  // a global shortcut, taken only while no capture owns Escape.
  grabEscape()
  log.event('overlay-presented', { taskId })
}

/** Hide the overlay (user-triggered dismiss). The task stays in the app. */
export function dismissOverlay(): void {
  releaseEscape()
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayWindow.hide()
    log.event('overlay-dismissed', {})
  }
}

export function isOverlayVisible(): boolean {
  return !!overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()
}
