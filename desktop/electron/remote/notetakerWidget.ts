// Meeting Notetaker — floating widget window (spec §7).
//
// A tiny, always-on-top, transparent, cross-Space window pinned to the
// BOTTOM-LEFT corner while a note-taking session is active: a small pill
// showing a live waveform, no timer (2026-08-26: was a circle, then a
// pill with a floating "Discard meeting" box above it; now ONE pill that
// turns white in place for both the discard option and the undo-window
// message — a separate floating element next to a small pill read as
// disproportionate no matter how either was sized on its own). Clicking
// the pill while recording splits it into an × (back out, no action) and
// a "Discard meeting" zone (confirms) — spec §6's "stop is never a
// single, direct action," just as two zones in one shape instead of two
// separate shapes. This module only shows/hides/positions the window; the
// click/confirm behavior itself lives in the renderer.
//
// Modeled directly on overlay.ts (the docked/expanded task overlay): same
// BrowserWindow config shape, same all-Spaces/full-screen-following setup,
// same dev-vs-packaged load pattern. Unlike overlay.ts's docked pill (which
// defaults to click-through so it never blocks the apps behind it), this
// widget is deliberately NOT click-through — spec §6/§7 require the click
// itself to reveal the discard option, and at a corner-docked ~260x26 it
// has negligible chance of being "in the way" the way a wider dock would.
//
// Electron glue (BrowserWindow/screen), so — like overlay.ts — not
// unit-tested (see notetakerWidget's sibling files for the same rationale).
//
// A SEPARATE stop signal (broadcastStopPending, notetaker:stop-pending)
// covers the keyboard's own single-tap stop: capture keeps running while it
// counts down, so it is not the same as captureActive going false. See
// NotetakerController.onNotesStopRequested for the arm/cancel/finalize shape
// this mirrors, and NotetakerWidget.tsx for the widget's visual response.

import { BrowserWindow, screen, ipcMain } from 'electron'
import { join } from 'node:path'
import { createLogger } from './log'

const log = createLogger('notetaker-widget')

/** Settings key for the notetaker widget's own screen-capture visibility.
 *  Deliberately NOT `showInScreenCapture`, which governs the notch and pill. */
export const WIDGET_CAPTURE_KEY = 'notetakerVisibleInScreenCapture'

/** Read once, injected, so this module stays testable without electron-store. */
let readVisible: () => boolean = () => false

export function setWidgetCaptureReader(fn: () => boolean): void { readVisible = fn }

/**
 * Hide the widget from screen capture unless the user has asked otherwise.
 *
 * DEFAULT HIDDEN. Every other surface defaults to visible because being in a
 * recording is merely untidy for them. This one is a meeting recorder, and
 * appearing in the meeting it is recording is a disclosure, not an aesthetic.
 */
export function refreshWidgetCapturePolicy(): void {
  if (widgetWindow && !widgetWindow.isDestroyed()) applyWidgetCapturePolicy(widgetWindow)
}

export function applyWidgetCapturePolicy(win: BrowserWindow): void {
  const visible = readVisible()
  try {
    win.setContentProtection(!visible)
    log.event('widget-capture-policy', { visibleInCapture: visible, contentProtection: !visible })
  } catch (e) {
    log.warn('setContentProtection failed', { error: (e as Error).message })
  }
}

let widgetWindow: BrowserWindow | null = null
/** When the CURRENT widgetWindow was created — null until createNotetakerWidget()
 *  first runs. Every broadcast/did-finish-load log below reports its elapsed
 *  time against this, since "the widget window hadn't finished loading yet"
 *  (a real, observed cause of a dropped capture-active signal — see
 *  broadcastCaptureActive's own comment) is only diagnosable if the log shows
 *  HOW LONG the window had been loading when a signal was sent. */
let windowCreatedAt: number | null = null

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
 *  state is cached and re-sent on every 'did-finish-load'.
 *
 *  LOGS THE "COULD NOT SEND" CASE EXPLICITLY, not just the successful send:
 *  a window that doesn't exist yet or is destroyed silently drops this call
 *  (the cache still updates, so did-finish-load's resend recovers it LATER
 *  — but only if that resend actually manages to reach a listener that has
 *  mounted by then; see NotetakerWidget.tsx's own new mount-timing logs). */
function broadcastCaptureActive(active: boolean): void {
  captureActive = active
  const msSinceWindowCreated = windowCreatedAt === null ? null : Date.now() - windowCreatedAt
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    log.event('capture-active-broadcast-dropped', { active, reason: !widgetWindow ? 'no-window' : 'window-destroyed', msSinceWindowCreated })
    return
  }
  log.event('capture-active-broadcast-sent', { active, webContentsIsLoading: widgetWindow.webContents.isLoading(), msSinceWindowCreated })
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
  const msSinceWindowCreated = windowCreatedAt === null ? null : Date.now() - windowCreatedAt
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    log.event('stop-pending-broadcast-dropped', { pending, reason: !widgetWindow ? 'no-window' : 'window-destroyed', msSinceWindowCreated })
    return
  }
  log.event('stop-pending-broadcast-sent', { pending, msSinceWindowCreated })
  widgetWindow.webContents.send('notetaker:stop-pending', pending)
}

/**
 * A THIRD, AUTHORITATIVE resend trigger — on top of the immediate send in
 * broadcastCaptureActive/broadcastStopPending and the inferred resend on
 * 'did-finish-load' above. Live-observed: on the widget's very first-ever
 * show() (right after app launch), BOTH of those could fire before this
 * window's React effects had actually registered their IPC listeners —
 * did-finish-load only proves the page's script started running, not that
 * React has mounted — so the very first meeting of a session sometimes
 * never acquired a mic (main believed it had told the widget to start; the
 * widget never heard it). This handler is fed by the renderer's OWN
 * confirmation that its listeners exist (see NotetakerWidgetRoute's
 * post-mount ready ping), so unlike the other two triggers, this one is
 * never a guess about timing.
 *
 * Registered once at module load — there is only ever one widget window
 * (the module-level `widgetWindow` singleton), so one handler for its whole
 * lifetime is correct; a fresh window still sends its own fresh ready ping
 * after its own fresh mount, and this handler just resends whatever the
 * CURRENT cached state is at that moment, same as the other two triggers.
 */
ipcMain.on('notetaker:widget-ready', () => {
  const msSinceWindowCreated = windowCreatedAt === null ? null : Date.now() - windowCreatedAt
  log.event('notetaker-widget-ready-received', { msSinceWindowCreated, resendingCaptureActive: captureActive, resendingStopPending: stopPending })
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  widgetWindow.webContents.send('notetaker:capture-active', captureActive)
  widgetWindow.webContents.send('notetaker:stop-pending', stopPending)
})

/** Bottom-left bounds on the display nearest the cursor — mirrors overlay.ts's
 *  dockedBounds() (screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea)
 *  but anchored to the opposite corner and sized for the pill.
 *
 *  Vertically level with the dictation pill cluster, not just "near the
 *  bottom": NotchGeometry.pillBottomInset (26pt) plus PillView's own 4pt
 *  bottom padding put the dictation pill's bottom edge 30pt above the visible
 *  frame's bottom edge. This flushes THIS pill's bottom edge to that same
 *  line too — a shared BOTTOM, not a shared center, since two different-
 *  height things read as "the same shelf" when their bases align, not
 *  their midpoints.
 *
 *  No extra height reserved above the pill anymore (2026-08-26): the
 *  discard option and the undo-window message both render IN the pill now
 *  (see NotetakerWidget.tsx) — nothing ever floats above it, so the window
 *  only ever needs to be exactly pill-height tall. Width is generous
 *  enough for the longest content that ever appears in the pill itself
 *  ("Press ⌃ again to keep recording") — the pill's own width is
 *  content-driven (CSS), this is just the window's outer budget. */
function widgetBounds(): { x: number; y: number; width: number; height: number } {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const wa = display.workArea
  // MUST MATCH NotetakerWidget.tsx's PILL_HEIGHT. The window is exactly as tall
  // as the pill, so a pill taller than this is CLIPPED — the widget's rounded
  // ends and border get sliced off and it reads as a cut rectangle rather than
  // a capsule. Duplicated across a process boundary, so it has to be changed in
  // both places or not at all.
  const pillHeight = 36
  const width = 260
  const xMargin = 16
  const baseline = 30 // matches the dictation pill's own clearance from the bottom
  const windowHeight = pillHeight
  return {
    width,
    height: windowHeight,
    x: wa.x + xMargin,
    y: wa.y + wa.height - baseline - windowHeight,
  }
}

/** Create the widget window (hidden). Idempotent, like overlay.ts's createOverlayWindow(). */
export function createNotetakerWidget(): BrowserWindow {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    log.event('notetaker-widget-create-reused', { msSinceWindowCreated: windowCreatedAt === null ? null : Date.now() - windowCreatedAt })
    return widgetWindow
  }
  const { x, y, width, height } = widgetBounds()
  windowCreatedAt = Date.now()

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
  // HIDDEN FROM SCREEN CAPTURE BY DEFAULT, and on its own preference.
  //
  // setContentProtection maps to NSWindow.sharingType = .none: the window is
  // omitted from screen recording, screen sharing and screenshots at the window
  // server, so a capture shows what is behind it rather than a black box.
  //
  // A SEPARATE SETTING from `showInScreenCapture`, which governs the notch and
  // pill. Those are cosmetic in a recording; a MEETING RECORDER visible in the
  // meeting it is recording is a different question entirely, and the answer
  // people want for it is not the answer they want for the dictation surfaces.
  // Hence its own key, defaulting to hidden.
  applyWidgetCapturePolicy(widgetWindow)

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
    const msSinceWindowCreated = windowCreatedAt === null ? null : Date.now() - windowCreatedAt
    log.event('notetaker-widget-did-finish-load', { msSinceWindowCreated, resendingCaptureActive: captureActive, resendingStopPending: stopPending })
    widgetWindow.webContents.send('notetaker:capture-active', captureActive)
    widgetWindow.webContents.send('notetaker:stop-pending', stopPending)
  })

  widgetWindow.on('closed', () => {
    log.event('notetaker-widget-closed', { msSinceWindowCreated: windowCreatedAt === null ? null : Date.now() - windowCreatedAt })
    widgetWindow = null
    windowCreatedAt = null
  })
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
  const alreadyExisted = !!widgetWindow && !widgetWindow.isDestroyed()
  const wasVisibleBefore = alreadyExisted && !!widgetWindow?.isVisible()
  const win = createNotetakerWidget()
  ensureWidgetRoute(win)
  win.setBounds(widgetBounds())
  if (!win.isVisible()) win.showInactive()
  reassertOmnipresence(win)
  log.event('notetaker-widget-shown', {
    windowAlreadyExisted: alreadyExisted,
    wasVisibleBefore,
    webContentsIsLoading: win.webContents.isLoading(),
  })
  // Arm the renderer's mic capture. This call site is exactly
  // NotetakerSession.start() (notetakerInit.ts injects showNotetakerWidget as
  // its onSessionStart hook), so the widget's mic is live for precisely as
  // long as a real capture is.
  broadcastCaptureActive(true)
}

/** Hide the widget without destroying it (fast to bring back). Called from
 *  NotetakerSession stop. */
export function hideNotetakerWidget(): void {
  const wasVisible = !!widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible()
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
  log.event('notetaker-widget-hidden', { wasVisible })
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
