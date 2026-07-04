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

import { BrowserWindow, globalShortcut } from 'electron'
import { join } from 'node:path'
import { createLogger } from './log'

const log = createLogger('orchestrate')
let wallWindow: BrowserWindow | null = null

/** Create the cockpit window (hidden). Idempotent. */
export function createOrchestrateWindow(): BrowserWindow {
  if (wallWindow && !wallWindow.isDestroyed()) return wallWindow

  wallWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Unmute Orchestrate',
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
