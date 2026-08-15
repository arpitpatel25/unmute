import { spawn, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'

export type KeyEvent = 'fn-down' | 'fn-up' | 'caps-down' | 'caps-up' | 'right-option-down' | 'right-option-up' | 'command-v'
  // Emitted ONLY when the Escape tap swallowed the key, so a listener that
  // hears this knows the app underneath did not. See setEscapeCapture.
  | 'escape'

// ─── AI format (instruction) enable/disable ─────────────────────
//
// When the user has disabled AI format in Settings, Caps Lock presses
// should be a no-op. We intercept here (at the listener layer) rather
// than inside keyboardManager so the OSS keyboard.ts stays untouched —
// any 'caps-down'/'caps-up' event is dropped before downstream consumers
// even see it.
//
// The flag is owned by paywall-glue.ts (which has the electron-store
// settings instance). It calls setInstructionEnabled() at startup with
// the persisted value, and again whenever the user toggles the setting.

let instructionEnabled = true

/** Called from paywall-glue at startup and on every IPC toggle. */
export function setInstructionEnabled(enabled: boolean): void {
  instructionEnabled = enabled
  console.log('[keyListener] instructionEnabled →', enabled)
}

/** Used only by IPC `get` so the renderer reads the same source of truth. */
export function getInstructionEnabled(): boolean {
  return instructionEnabled
}

// ─── Native addon shape (loaded lazily) ────────────────────────────
//
// Why this file exists as an override:
// The OSS keyListener spawns Contents/Resources/bin/globe-listener as a
// CHILD process and pipes its stdout for modifier events. macOS TCC keys
// Input Monitoring + Accessibility grants by per-binary code-signature
// identity — and the child binary has its own identity, separate from the
// .app bundle. So even after the user grants permissions to "unmute" in
// System Settings, the child silently fails to receive keyboard events.
// ~50% of OSS users hit this.
//
// This override prefers the in-process unmute-native-fn-listener addon,
// which runs in the SAME process as the .app and inherits the bundle's
// TCC grants automatically. Same fix pattern as unmute-native-paste.
//
// If the addon fails to load (missing .node, build error, non-mac), we
// fall back to spawning the legacy child binary so we never regress
// silently. Both paths emit the same KeyEvent values, so all downstream
// consumers (keyboard.ts, sessionManager.ts, paywall-glue.ts) are
// unchanged.

interface FnAddon {
  start(cb: (event: KeyEvent) => void): boolean
  stop(): boolean
  isAccessibilityTrusted(): boolean
  /** Swallow plain Escape before the frontmost app sees it. Optional so an
   *  older .node binary degrades to today's leak rather than throwing. */
  setEscapeCapture?(on: boolean): boolean
}

let cachedAddon: FnAddon | null | undefined = undefined
function getFnAddon(): FnAddon | null {
  if (cachedAddon !== undefined) return cachedAddon
  if (process.platform !== 'darwin') {
    cachedAddon = null
    return null
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('unmute-native-fn-listener') as FnAddon
    if (typeof mod?.start !== 'function' || typeof mod?.stop !== 'function') {
      console.warn('[keyListener] addon loaded but missing start/stop — will fall back')
      cachedAddon = null
      return null
    }
    console.log('[keyListener] native addon loaded — in-process Fn detection')
    cachedAddon = mod
    return mod
  } catch (e) {
    console.warn(
      '[keyListener] native-fn-listener addon failed to load — falling back to child binary:',
      e instanceof Error ? e.message : e,
    )
    cachedAddon = null
    return null
  }
}

class KeyListener extends EventEmitter {
  // Native addon state — preferred path.
  private addonRunning = false

  // Legacy child-binary state — fallback path. Kept verbatim from the
  // OSS implementation so behavior is identical when the addon isn't
  // available (e.g., non-mac dev, missing .node file).
  private process: ChildProcess | null = null
  private restarting = false

  getBinaryPath(): string | null {
    const candidates = [
      path.join(process.resourcesPath || '', 'bin', 'globe-listener'),
      path.join(app.getAppPath(), 'resources', 'bin', 'globe-listener'),
      path.join(__dirname, '..', '..', 'resources', 'bin', 'globe-listener'),
    ]
    for (const candidate of candidates) {
      console.log('[keyListener] Checking binary path:', candidate, '→', fs.existsSync(candidate) ? 'FOUND' : 'not found')
      if (fs.existsSync(candidate)) return candidate
    }
    return null
  }

  /** Single chokepoint for emitting key events. Drops Caps events when
   *  AI format is disabled so downstream consumers (keyboardManager,
   *  sessionManager) don't need to know about the setting. */
  private emitKey(event: KeyEvent): void {
    if ((event === 'caps-down' || event === 'caps-up') && !instructionEnabled) {
      return
    }
    this.emit('key', event)
  }

  start(): boolean {
    if (process.platform !== 'darwin') {
      console.log('[keyListener] Not macOS, skipping native key listener')
      return false
    }

    // 1. Try the in-process addon first.
    const addon = getFnAddon()
    if (addon) {
      try {
        const ok = addon.start((event: KeyEvent) => {
          this.emitKey(event)
        })
        if (ok) {
          this.addonRunning = true
          return true
        }
        console.warn('[keyListener] addon start() returned false — falling back')
      } catch (e) {
        console.warn(
          '[keyListener] addon start() threw — falling back:',
          e instanceof Error ? e.message : e,
        )
      }
    }

    // 2. Fall back to the legacy child-binary path.
    return this.startChildBinary()
  }

  /** Legacy path — only used when the native addon is unavailable. */
  private startChildBinary(): boolean {
    const binaryPath = this.getBinaryPath()
    if (!binaryPath) {
      console.error('[keyListener] Globe listener binary not found AND native addon unavailable')
      return false
    }
    try {
      fs.chmodSync(binaryPath, 0o755)
    } catch {
      // Ignore — packaged app may have read-only resources.
    }

    console.log('[keyListener] Starting globe listener (legacy child-binary path):', binaryPath)
    this.process = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })

    let buffer = ''
    this.process.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        switch (trimmed) {
          case 'FN_DOWN': this.emitKey('fn-down' as KeyEvent); break
          case 'FN_UP': this.emitKey('fn-up' as KeyEvent); break
          case 'CAPS_DOWN': this.emitKey('caps-down' as KeyEvent); break
          case 'CAPS_UP': this.emitKey('caps-up' as KeyEvent); break
          case 'RIGHT_OPTION_DOWN': this.emitKey('right-option-down' as KeyEvent); break
          case 'RIGHT_OPTION_UP': this.emitKey('right-option-up' as KeyEvent); break
          case 'PASTE_OK':
          case 'COPY_OK': break
        }
      }
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      console.error('[keyListener] stderr:', data.toString())
    })
    this.process.on('error', (err) => {
      console.error('[keyListener] Process error:', err.message)
      this.emit('error', err)
    })
    this.process.on('exit', (code) => {
      console.log('[keyListener] Process exited with code:', code)
      this.process = null
      if (!this.restarting && code !== 0 && code !== null) {
        this.restarting = true
        console.log('[keyListener] Will auto-restart in 2s...')
        setTimeout(() => {
          this.restarting = false
          this.start()
        }, 2000)
      }
    })
    this.process.stdout?.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'EPIPE') return
      console.error('[keyListener] stdout error:', err.message)
    })
    this.process.stderr?.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'EPIPE') return
      console.error('[keyListener] stderr error:', err.message)
    })
    return true
  }

  /**
   * Send a command to the globe-listener process via stdin. Used by the
   * legacy paste-via-CGEvent path. In our build the native-paste addon
   * already handles paste/copy in-process, so this is effectively dead
   * code — but we preserve the API surface for any OSS code that still
   * calls it (and so this file remains a drop-in replacement).
   *
   * When the in-process Fn addon is active, no child binary exists; we
   * reject with a clear error so the caller can fall back to its own
   * path (which is what clipboard.ts already does — it tries native-paste
   * first).
   */
  sendCommand(command: 'PASTE' | 'COPY'): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin || this.process.killed) {
        reject(new Error('Globe listener child process not running (native addon path is active)'))
        return
      }
      const expectedResponse = `${command}_OK`
      const timeoutMs = 500
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`${command} command timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const onData = (data: Buffer) => {
        const lines = data.toString().split('\n')
        for (const line of lines) {
          if (line.trim() === expectedResponse) {
            cleanup()
            resolve()
            return
          }
        }
      }
      const cleanup = () => {
        clearTimeout(timeout)
        this.process?.stdout?.removeListener('data', onData)
      }
      this.process.stdout?.on('data', onData)
      this.process.stdin.write(command + '\n', (err) => {
        if (err) {
          cleanup()
          reject(err)
        }
      })
    })
  }

  /** Returns true if either the addon or the child binary is active. */
  isRunning(): boolean {
    if (this.addonRunning) return true
    return !!(this.process && !this.process.killed && this.process.stdin)
  }

  stop(): void {
    this.restarting = true
    if (this.addonRunning) {
      try {
        getFnAddon()?.stop()
      } catch (e) {
        console.warn('[keyListener] addon stop threw:', e instanceof Error ? e.message : e)
      }
      this.addonRunning = false
    }
    if (this.process) {
      this.process.kill()
      this.process = null
    }
  }
}

export const keyListener = new KeyListener()


/**
 * OWN ESCAPE, BUT ONLY WHILE IT IS OURS.
 *
 * With the notch expanded, Escape reached BOTH the notch and the app beneath —
 * a fullscreen video would exit fullscreen as the surface closed. The notch's
 * global monitor sees that Escape but macOS makes global monitors observe-only,
 * so it can report the leak and not stop it. A CGEventTap can, and it is the
 * only thing that can.
 *
 * The whole safety of this is in WHEN it is on. Callers enable capture for the
 * states where Escape means "close this surface" or "cancel this dictation",
 * and disable it the instant that stops being true. Off, the tap is disabled
 * and Escape behaves exactly as macOS intends everywhere.
 *
 * Fail-open by construction: an addon too old to have the export, or a tap the
 * system refuses to create, simply returns false and leaves Escape alone.
 */
export function setEscapeCapture(on: boolean): boolean {
  const addon = getFnAddon()
  if (!addon || typeof addon.setEscapeCapture !== 'function') return false
  try {
    return addon.setEscapeCapture(on)
  } catch (e) {
    console.warn('[keyListener] setEscapeCapture failed — Escape left to the system:', e instanceof Error ? e.message : e)
    return false
  }
}
