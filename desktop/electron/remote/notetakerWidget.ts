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
// itself to surface Cancel, and at 108x82 (a 56px circle plus room for its
// hover label) in a corner it has negligible chance of being "in the way"
// the way a wider dock would.
//
// Electron glue (BrowserWindow/screen), so — like overlay.ts — not
// unit-tested (see notetakerWidget's sibling files for the same rationale).
//
// A SEPARATE stop signal (broadcastStopPending, notetaker:stop-pending)
// covers the keyboard's own single-tap stop: capture keeps running while it
// counts down, so it is not the same as captureActive going false. See
// NotetakerController.onNotesStopRequested for the arm/cancel/finalize shape
// this mirrors, and NotetakerWidget.tsx for the widget's visual response.

import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { createLogger } from './log'

const log = createLogger('notetaker-widget')

let widgetWindow: BrowserWindow | null = null

/** The capture-active signal last broadcast to the widget's renderer.
 *
 *  WHY THIS EXISTS: the window is deliberately REUSED across sessions
 *  (hide, not close — creating a transparent always-on-top panel is not
 *  free), and it runs with `backgroundThrottling: false` +
 *  `paintWhenInitiallyHidden: true`. That combination means
 *  NotetakerWidgetRoute never unmounts between sessions, so a mount-time
 *  `getUserMedia()` would keep a SECOND live mic capture open for the rest
 *  of the app's run after the first session — macOS mic indicator stuck on,
 *  Bluetooth pinned to the low-quality HFP codec, and dictation quality
 *  degraded. So capture is gated on this signal instead: the renderer
 *  acquires the mic when it goes true and fully tears it down (tracks
 *  stopped, AudioContext closed, rAF cancelled) when it goes false. */
let captureActive = false

/** Tell the widget's renderer whether a REAL capture is running. Safe to
 *  call before the window exists or before its renderer has loaded — the
 *  state is cached and re-sent on every 'did-finish-load'. */
function broadcastCaptureActive(active: boolean): void {
  captureActive = active
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  widgetWindow.webContents.send('notetaker:capture-active', active)
}

/** Last stop-pending state broadcast — same re-send-on-load reasoning as
 *  `captureActive` above, and reset to false whenever a session ends (see
 *  hideNotetakerWidget) so a stale pending tint can never survive into the
 *  next meeting's widget. */
let stopPending = false

/** Tell the widget's renderer whether a manual (keyboard) stop is currently
 *  in its undo window — see NotetakerController.onNotesStopRequested. Wired
 *  as notetakerInit.ts's onStopPendingChanged hook, the same cross-tree
 *  pattern as onSessionStart/onSessionStop (see that file's header comment
 *  on why this widget can only be reached via injected hooks). */
export function broadcastStopPending(pending: boolean): void {
  stopPending = pending
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  widgetWindow.webContents.send('notetaker:stop-pending', pending)
}

/** Bottom-left bounds on the display nearest the cursor — mirrors overlay.ts's
 *  dockedBounds() (screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea)
 *  but anchored to the opposite corner and sized for a small circle.
 *
 *  Vertically level with the dictation pill cluster, not just "near the
 *  bottom": NotchGeometry.pillBottomInset (26pt) plus PillView's own 4pt
 *  bottom padding put the dictation pill's bottom edge 30pt above the visible
 *  frame's bottom edge. This flushes the circle's bottom edge to that same
 *  line — a shared BOTTOM, not a shared center, because the pill is 44pt tall
 *  and this circle is 56pt, and two different-sized things read as "the same
 *  shelf" when their bases align, not their midpoints.
 *
 *  The window is taller than the circle (labelAreaHeight) to leave room for
 *  the hover-revealed "Note taker" label below it (see NotetakerWidget.tsx)
 *  — reserved at all times, not click-through, the same tradeoff already
 *  made for the circle's own square hit-box. */
function widgetBounds(): { x: number; y: number; width: number; height: number } {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const wa = display.workArea
  const circleSize = 56 // circular, small — spec §7: "not buried, more like a floating thing"
  const labelAreaHeight = 26
  const xMargin = 16
  const baseline = 30 // matches the dictation pill's own clearance from the bottom
  return {
    width: 108,
    height: circleSize + labelAreaHeight,
    x: wa.x + xMargin,
    y: wa.y + wa.height - baseline - circleSize,
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

  // Re-assert the capture-active signal after every load. The renderer is
  // the only thing that can hold the mic open, and it can miss the initial
  // send in two real cases: the very first show() (the window is created and
  // told to load in the same tick, long before the route has mounted a
  // listener), and a dev-mode Vite HMR full reload mid-session. Re-sending on
  // load makes the signal self-healing in both.
  widgetWindow.webContents.on('did-finish-load', () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return
    widgetWindow.webContents.send('notetaker:capture-active', captureActive)
    widgetWindow.webContents.send('notetaker:stop-pending', stopPending)
  })

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
  // Arm the renderer's mic capture. This call site is exactly
  // NotetakerSession.start() (notetakerInit.ts injects showNotetakerWidget as
  // its onSessionStart hook), so the widget's mic is live for precisely as
  // long as a real capture is.
  broadcastCaptureActive(true)
  log.event('notetaker-widget-shown', {})
}

/** Hide the widget without destroying it (fast to bring back). Called from
 *  NotetakerSession stop. */
export function hideNotetakerWidget(): void {
  // Disarm BEFORE hiding: hiding alone does not unmount the renderer (the
  // window keeps running unthrottled), so without this the widget's
  // getUserMedia stream would stay open forever — see `captureActive` above.
  broadcastCaptureActive(false)
  // Defensive reset, mirroring captureActive: the controller already clears
  // this before a real stop (see NotetakerController.finalizeStop), so this
  // is normally a no-op — but it guarantees the NEXT session's widget can
  // never open already tinted from a stale pending-stop that never resolved.
  broadcastStopPending(false)
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
  broadcastCaptureActive(false)
  broadcastStopPending(false)
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    closeWindow(widgetWindow)
  }
  widgetWindow = null
}

export function isNotetakerWidgetVisible(): boolean {
  return !!widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible()
}
