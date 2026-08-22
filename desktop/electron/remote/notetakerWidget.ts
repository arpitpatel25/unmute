// Meeting Notetaker — floating widget window (spec §7).
//
// A tiny, always-on-top, transparent, cross-Space window pinned to the
// BOTTOM-LEFT corner while a note-taking session is active: a small circle
// showing a live waveform, no timer. Clicking it surfaces a Cancel
// affordance (spec §6) — stopping is never a single click, it always
// requires a second confirming click (the confirm step itself lives in the
// renderer; this module only shows/hides/positions the window).
//
// Modeled directly on overlay.ts (the docked/expanded task overlay): same
// BrowserWindow config shape, same all-Spaces/full-screen-following setup,
// same dev-vs-packaged load pattern. Unlike overlay.ts's docked pill (which
// defaults to click-through so it never blocks the apps behind it), this
// widget is deliberately NOT click-through — spec §6/§7 require the click
// itself to surface Cancel, and at 56x56 in a corner it has negligible
// chance of being "in the way" the way a wider dock would.
//
// Electron glue (BrowserWindow/screen), so — like overlay.ts — not
// unit-tested (see notetakerWidget's sibling files for the same rationale).

import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { createLogger } from './log'

const log = createLogger('notetaker-widget')

let widgetWindow: BrowserWindow | null = null

/** Bottom-left bounds on the display nearest the cursor — mirrors overlay.ts's
 *  dockedBounds() (screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea)
 *  but anchored to the opposite corner and sized for a small circle. */
function widgetBounds(): { x: number; y: number; width: number; height: number } {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const wa = display.workArea
  const size = 56 // circular, small — spec §7: "not buried, more like a floating thing"
  const margin = 16
  return {
    width: size,
    height: size,
    x: wa.x + margin,
    y: wa.y + wa.height - size - margin,
  }
}

/** Create the widget window (hidden). Idempotent, like overlay.ts's createOverlayWindow(). */
export function createNotetakerWidget(): BrowserWindow {
  if (widgetWindow && !widgetWindow.isDestroyed()) return widgetWindow
  const { x, y, width, height } = widgetBounds()

  widgetWindow = new BrowserWindow({
    width, height, x, y,
    frame: false,
    transparent: true,
    // Native transparent backing — without this the window flashes an opaque
    // fill during Space transitions before the CSS paints (same reasoning as
    // overlay.ts).
    backgroundColor: '#00000000',
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    // Keep painting even when backgrounded / on a non-active Space, so the
    // waveform doesn't freeze on a stale frame when the user is on another
    // display/Space (same fix overlay.ts applies for the same reason).
    paintWhenInitiallyHidden: true,
    focusable: true,
    // Accept the first click even when not active, so a click registers
    // Cancel immediately instead of merely raising the window.
    acceptFirstMouse: true,
    type: 'panel',
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  // 'screen-saver' level + visibleOnFullScreen: stays pinned over everything,
  // including full-screen Spaces (a meeting is very likely to BE a full-screen
  // Space) — identical reasoning and recipe as overlay.ts.
  widgetWindow.setAlwaysOnTop(true, 'screen-saver')
  widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  widgetWindow.setFullScreenable(false)

  if (process.env.ELECTRON_RENDERER_URL) {
    void widgetWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/notetaker-widget`)
  } else {
    void widgetWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/notetaker-widget' })
  }

  widgetWindow.on('closed', () => { widgetWindow = null })
  log.event('notetaker-widget-created', {})
  return widgetWindow
}

/** Make sure the window is on the #/notetaker-widget route before showing it.
 *  In dev, a Vite HMR full-reload can navigate the window to the base URL and
 *  drop the hash, leaving the shared renderer on the main <App> instead — same
 *  drift guard as overlay.ts's ensureOverlayRoute(). No-op in the normal case;
 *  can't happen in a packaged build. */
function ensureWidgetRoute(win: BrowserWindow): void {
  if (win.webContents.getURL().includes('#/notetaker-widget')) return
  log.event('notetaker-widget-route-reasserted', {})
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/notetaker-widget`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/notetaker-widget' })
  }
}

/** Re-assert the all-Spaces + level flags — macOS can drop the collection
 *  behavior after a show/hide (same as overlay.ts's reassertOmnipresence()). */
function reassertOmnipresence(win: BrowserWindow): void {
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.setAlwaysOnTop(true, 'screen-saver')
}

/** Show the widget, re-placing it on the display nearest the cursor. Shown
 *  with showInactive() so it never steals focus (same rule overlay.ts follows
 *  for its own presentations). Called from NotetakerSession start, per the
 *  plan: the widget's visibility must always match actual capture state. */
export function showNotetakerWidget(): void {
  const win = createNotetakerWidget()
  ensureWidgetRoute(win)
  win.setBounds(widgetBounds())
  if (!win.isVisible()) win.showInactive()
  reassertOmnipresence(win)
  log.event('notetaker-widget-shown', {})
}

/** Hide the widget without destroying it (fast to bring back). Called from
 *  NotetakerSession stop. */
export function hideNotetakerWidget(): void {
  if (widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible()) {
    widgetWindow.hide()
  }
  log.event('notetaker-widget-hidden', {})
}

/** `close()` isn't in our trimmed Electron typings (same situation overlay.ts
 *  notes for setIgnoreMouseEvents) — cast through the real method's shape. */
function closeWindow(win: BrowserWindow): void {
  ;(win as unknown as { close: () => void }).close()
}

/** Tear the window down entirely (app quit / feature teardown). */
export function destroyNotetakerWidget(): void {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    closeWindow(widgetWindow)
  }
  widgetWindow = null
}

export function isNotetakerWidgetVisible(): boolean {
  return !!widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible()
}
