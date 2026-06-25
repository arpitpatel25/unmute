// Unmute Remote — floating task overlay window (DECIDED: replaces OS notifications).
//
// A second always-on-top, transparent, cross-Space window (separate from the
// dictation pill). It has two presentations:
//
//   * EXPANDED — the full translucent task panel (right-center, 400px). Auto-
//     presents when a task enters a terminal/attention state (done / failed /
//     needs-user / stuck) so the user sees the result/answer WHERE THEY ARE.
//   * DOCKED — a compact pill in the bottom-right showing just the live counts
//     ("N running · M stuck"). Present whenever there's an active task. Clicking
//     it (or a notify-state event) animates it up into the EXPANDED panel; Esc
//     collapses it back down.
//
// Docked mode is governed by the `overlayDocked` setting (default ON). With it
// OFF, the window behaves exactly as before: no dock, auto-present pops the full
// panel, Esc/✕ hide it.
//
// Rules:
//   * NEVER auto-dismiss — the panel/dock only closes on a user action (Esc, ✕)
//     or when there's genuinely nothing active (the dock auto-hides when idle).
//   * ✕ dismisses for the SESSION; a NEW task brings the dock back.
//   * Shown with showInactive() so it never steals focus.
//
// Electron glue (BrowserWindow/screen), so — like init.ts — not unit-tested.

import { BrowserWindow, screen, globalShortcut } from 'electron'
import { join } from 'node:path'
import { createLogger } from './log'

const log = createLogger('overlay')

export type OverlayMode = 'hidden' | 'docked' | 'expanded'

let overlayWindow: BrowserWindow | null = null
// Whether WE currently hold the global Escape shortcut (vs the engine, which
// grabs it during a dictation/remote capture so its cancel wins). We only take
// Escape while the overlay is EXPANDED and no capture owns it.
let escHeldByOverlay = false
// Mirror of the `overlayDocked` setting (init pushes it in). When false we use
// the legacy behavior (no dock; auto-present pops the full panel).
let dockedEnabled = true
let mode: OverlayMode = 'hidden'
// Set by the ✕; suppresses re-docking until a NEW task arrives (then reset).
let sessionDismissed = false
// Most recent count of running/needs-user/stuck tasks — drives whether a
// collapse lands on the dock (something active) or hides entirely (nothing).
let lastActiveCount = 0

/** Take global Escape → collapse/dismiss (only if no capture holds it). */
function grabEscape(): void {
  if (escHeldByOverlay) return
  try {
    if (!globalShortcut.isRegistered('Escape')) {
      escHeldByOverlay = globalShortcut.register('Escape', () => handleEscape())
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

/** Called when a capture ends: reclaim Escape if the overlay is still EXPANDED. */
export function resumeOverlayEscape(): void { if (mode === 'expanded') grabEscape() }

/** Escape while EXPANDED: in docked mode, collapse back to the pill (or hide if
 *  nothing's active); in legacy mode, hide the panel (today's behavior). */
function handleEscape(): void {
  if (dockedEnabled) collapseOrHide()
  else hideOverlay()
}

/** Expanded bounds: a tall, narrow panel on the active display's right side. */
function expandedBounds(): { x: number; y: number; width: number; height: number } {
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

/** Docked bounds: a small pill in the bottom-right of the active display. */
function dockedBounds(): { x: number; y: number; width: number; height: number } {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const wa = display.workArea
  const width = 260
  const height = 64
  const margin = 16
  return {
    width,
    height,
    x: wa.x + wa.width - width - margin,
    y: wa.y + wa.height - height - margin,
  }
}

/** Create the overlay window (hidden). Idempotent. */
export function createOverlayWindow(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow
  const { x, y, width, height } = expandedBounds()

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

  // 'screen-saver' level sits ABOVE full-screen apps (the 'floating' level sat
  // below them, so the overlay vanished over fullscreen video/apps). Combined
  // with visibleOnFullScreen (the fullScreenAuxiliary collection behavior), this
  // is the standard recipe for an overlay that stays pinned over EVERYTHING,
  // including full-screen Spaces. (DRM players / exclusive-fullscreen games can
  // still block any overlay — an OS limit, not ours.)
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  // skipTransformProcessType:true stops Electron from flipping the process type
  // when it joins all Spaces — that transform is what gave the window a "home"
  // Space and made it flicker-in-then-vanish during Space swipes. With it, the
  // window genuinely lives on every Space (incl. full-screen).
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  overlayWindow.setFullScreenable(false)

  if (process.env.ELECTRON_RENDERER_URL) {
    void overlayWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/overlay`)
  } else {
    void overlayWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/overlay' })
  }

  overlayWindow.on('closed', () => { releaseEscape(); overlayWindow = null; mode = 'hidden' })
  log.event('overlay-window-created', {})
  return overlayWindow
}

/** Make sure the window is on the #/overlay route before we show it. In dev a
 *  Vite HMR full-reload can navigate the window to the base URL and drop the
 *  hash, so the shared renderer falls back to the main <App> (and Esc/✕ — which
 *  live in OverlayApp — stop working). If the hash drifted, reload onto the
 *  route. No-op in the normal case; can't happen in a packaged build. */
function ensureOverlayRoute(win: BrowserWindow): void {
  if (win.webContents.getURL().includes('#/overlay')) return
  log.event('overlay-route-reasserted', {})
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/overlay`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/overlay' })
  }
}

/** Tell the renderer which presentation to draw (pill vs full panel) + whether
 *  docked mode is on (so it can label Esc as "collapse" vs "dismiss"). */
function sendMode(win: BrowserWindow): void {
  win.webContents.send('remote:overlay-mode', { mode, docked: dockedEnabled })
}

/** Re-assert the all-Spaces + level flags — macOS can drop the collection
 *  behavior after a show/hide, which is what let it slip back to a single Space. */
function reassertOmnipresence(win: BrowserWindow): void {
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.setAlwaysOnTop(true, 'screen-saver')
}

/** Show/resize the window to the given presentation. Animates the resize when
 *  the window is already visible (so dock↔expand glides); just places it when
 *  appearing fresh. Shown inactive so it never steals focus. */
function showAs(m: 'docked' | 'expanded', bounds: { x: number; y: number; width: number; height: number }): BrowserWindow {
  const win = createOverlayWindow()
  ensureOverlayRoute(win)
  mode = m
  sendMode(win)
  // Snap the window instantly (NO native bounds animation): the macOS frame
  // animation runs independently of the React content, which desyncs and looks
  // distorted/shaky. The dock↔panel transition is animated in CSS instead (the
  // content is always sized correctly, so it's smooth). See OverlayApp.
  win.setBounds(bounds)
  if (!win.isVisible()) win.showInactive()
  reassertOmnipresence(win)
  if (m === 'expanded') grabEscape()
  else releaseEscape() // no Esc handling while docked — ✕ closes, click expands
  return win
}

/** Push the docked-mode setting in (init owns the settings store). Turning it
 *  off while docked hides the pill (legacy has no dock). */
export function setDockedMode(enabled: boolean): void {
  dockedEnabled = enabled
  if (!enabled && mode === 'docked') hideOverlay()
  log.event('overlay-docked-mode-set', { enabled })
}

/** Reconcile the docked pill with the live active-task count. Shows the pill
 *  when something's active, hides it when nothing is. No-op in legacy mode, and
 *  never disturbs an already-expanded panel. */
export function reconcileDock(activeCount: number): void {
  lastActiveCount = activeCount
  if (!dockedEnabled || mode === 'expanded' || sessionDismissed) return
  if (activeCount > 0) showAs('docked', dockedBounds())
  else if (mode === 'docked') hideOverlay()
}

/** A new task arrived → clear a prior ✕ dismissal so the dock comes back. */
export function onNewTask(activeCount: number): void {
  sessionDismissed = false
  reconcileDock(activeCount)
}

/** Expand to the full panel, optionally focusing a task. Used by the dock click,
 *  the auto-present trigger (docked mode), and the manual "open" button. */
export function expandOverlay(taskId?: string): void {
  const win = showAs('expanded', expandedBounds())
  if (taskId) win.webContents.send('remote:overlay-focus', { taskId })
  log.event('overlay-expanded', { taskId: taskId ?? null })
}

/** Terminal/attention trigger (done / failed / needs-user / stuck). In docked
 *  mode this animates the dock up into the full panel; in legacy mode it pops
 *  the full panel as before. Honors a prior ✕ dismissal (docked mode only). */
export function presentOrExpand(taskId: string): void {
  if (dockedEnabled && sessionDismissed) return // user closed it; wait for a new task
  expandOverlay(taskId)
}

/** Manual open from the app (a button next to "Kill all") — full panel, no focus. */
export function openOverlay(): void {
  expandOverlay()
  log.event('overlay-opened', {})
}

/** Esc while expanded: collapse to the dock if something's active, else hide. */
function collapseOrHide(): void {
  if (lastActiveCount > 0) {
    showAs('docked', dockedBounds())
    log.event('overlay-collapsed', {})
  } else {
    hideOverlay()
  }
}

/** Hide the window without marking the session dismissed (idle auto-hide / Esc
 *  in legacy mode). The task stays in the app. */
function hideOverlay(): void {
  releaseEscape()
  mode = 'hidden'
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayWindow.hide()
  }
}

/** ✕ — dismiss for this session. Won't re-dock until a NEW task arrives. */
export function dismissOverlay(): void {
  sessionDismissed = true
  hideOverlay()
  log.event('overlay-dismissed', {})
}

export function getOverlayMode(): { mode: OverlayMode; docked: boolean } {
  return { mode, docked: dockedEnabled }
}

export function isOverlayVisible(): boolean {
  return !!overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()
}
