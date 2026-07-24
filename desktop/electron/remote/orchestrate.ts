// Unmute Orchestrate — the cockpit window (NEW surface, handoff §3 #3).
//
// Unlike the floating overlay (a transparent always-on-top panel), the wall is a
// normal, framed, resizable window — a place the user goes to conduct many
// sessions. It loads the #/orchestrate renderer route with the SAME preload, so
// the wall sees the real electronAPI / useRemoteTasks store (one task object,
// shared with the overlay — integration, not a parallel store).
//
// Electron glue (BrowserWindow/globalShortcut) — like overlay.ts, not unit-tested.
// During build-out it's reachable via a toggle shortcut (⌘⇧O); a proper entry
// point (menu / pill affordance) comes once the surface settles.

import { BrowserWindow, globalShortcut, screen } from 'electron'
import { join } from 'node:path'
import { createLogger } from './log'

const log = createLogger('orchestrate')
let wallWindow: BrowserWindow | null = null

/** Create the cockpit window (hidden). Idempotent. */
export function createOrchestrateWindow(): BrowserWindow {
  if (wallWindow && !wallWindow.isDestroyed()) return wallWindow

  // The cockpit is the notch's FULL EXPAND (spec 2026-07-24 §3 state 4): it
  // hangs from the top-center of the active display at ~70% — big enough to
  // survey everything, deliberately not full-screen (the user can still zoom).
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const width = Math.round(Math.min(Math.max(workArea.width * 0.7, 900), workArea.width - 40))
  const height = Math.round(Math.min(Math.max(workArea.height * 0.72, 560), workArea.height - 20))

  wallWindow = new BrowserWindow({
    width,
    height,
    x: workArea.x + Math.round((workArea.width - width) / 2), // centered…
    y: workArea.y,                                            // …hanging from the top
    show: false,
    // The cockpit is the NOTCH EXPANDING (spec 2026-07-24), not a separate app:
    // no title bar / traffic lights (frame:false), can't be dragged around
    // (movable:false), fixed size hanging from the top. It reads as the notch
    // stretching open rather than "an Electron window with a title on it."
    frame: false,
    movable: false,
    resizable: false,
    fullscreenable: false,
    roundedCorners: true,
    backgroundColor: '#0d0f12', // Ops Console bg — no opaque flash before paint
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void wallWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/orchestrate`)
  } else {
    void wallWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/orchestrate' })
  }

  // Frameless + non-movable means there's no title-bar close button, so Escape
  // is the way out — it collapses the expanded notch back to the idle pill
  // (spec 2026-07-24 §3: Escape collapses the cockpit). Hide (not close) so the
  // window stays warm for the next open.
  wallWindow.webContents.on('before-input-event', ((event: unknown, input: unknown) => {
    const inp = input as { type?: string; key?: string }
    if (inp.type === 'keyDown' && inp.key === 'Escape') {
      ;(event as { preventDefault: () => void }).preventDefault()
      wallWindow?.hide()
    }
  }) as (...a: unknown[]) => void)

  wallWindow.on('closed', () => { wallWindow = null })
  return wallWindow
}

/** Show/hide the cockpit. */
export function toggleOrchestrateWindow(): void {
  const w = createOrchestrateWindow()
  if (w.isVisible()) { w.hide(); return }
  w.show()
  w.focus()
}

/** Open + focus the cockpit (idempotent). */
export function openOrchestrateWindow(): void {
  const w = createOrchestrateWindow()
  w.show()
  w.focus()
}

/** Dev/build-out affordance: ⌘⇧O toggles the wall. Best-effort. */
export function registerOrchestrateShortcut(): void {
  try {
    const ok = globalShortcut.register('CommandOrControl+Shift+O', toggleOrchestrateWindow)
    log.info('shortcut', { accel: 'CommandOrControl+Shift+O', registered: ok })
  } catch (err) {
    log.warn('shortcut-failed', { error: err instanceof Error ? err.message : String(err) })
  }
}
