import { clipboard, app } from 'electron'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { keyListener } from './keyListener'
// Static import (a lazy require of this path can't resolve inside the bundled
// main — proven live: 'Cannot find module' swallowed by the fail-open catch).
// NO CYCLE, AND IT HAS TO STAY THAT WAY: remote/capture imports nothing from
// engine-overrides. The paste effect it needs is REGISTERED into it by
// sessionManager (registerPaste), never imported from here — see the façade's
// header. Adding an import the other way closes the loop this comment exists
// to prevent.
import { noteOwnClipboardWrite } from './paywall/remote/capture/index'

/**
 * Announce a pasteboard write we caused.
 *
 * MUST BE CALLED SYNCHRONOUSLY, WITH NO `await` BETWEEN THE WRITE AND THE
 * CALL. noteOwnWrite reads the change counter AT CALL TIME and records that
 * value; the watcher polls every 250ms, so any suspension between the write
 * and the record lets the poll observe our own write as a user copy — and a
 * user copy becomes an insert at the top of the transcript.
 *
 * THIS IS NOT WHAT MAKES captureSelectedText SAFE. It cannot be: the
 * synthesised ⌘C is performed by another process, so its counter value is
 * unknowable until the child returns, and a poll landing in between has
 * already fired. The caller suspends observation around that whole sequence
 * instead (beginOwnClipboardSequence). These records remain because the
 * invariant is per-WRITE, not per-caller: injectOutput and copyToClipboard are
 * not wrapped in a sequence and still need to announce themselves, and any
 * future caller that forgets to wrap gets the narrow protection rather than
 * none.
 *
 * Fail-open: an unarmed (or absent) watcher has nothing to record, and a
 * throw here must never reach the dictation path.
 */
function noteOurWrite(): void {
  try { noteOwnClipboardWrite() } catch { /* watcher not armed — nothing to record */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Native paste addon (unmute-native-paste) ──────────────────────
// Lazy + defensive load. If the .node binary is missing, ABI-mismatched,
// or the require throws for any reason, we log the exact reason ONCE and
// silently fall back to osascript on every subsequent paste. Never throws
// during clipboard import — that would crash the renderer.
//
// The addon ships as a sibling node_modules entry (wire_paywall adds it
// to the OSS engine's package.json as a `file:./native-paste` path-based
// dep, electron-builder's install-app-deps postinstall rebuilds it for
// Electron's Node ABI).

interface NativePasteResult {
  ax_trusted: boolean
  source_created: boolean
  events_created: boolean
  posted: boolean
  ok: boolean
  stepFailed?: string
  error?: string
}

interface NativePasteAddon {
  isAccessibilityTrusted(): boolean
  postCmdV(): NativePasteResult
  processInfo(): { pid: number; executablePath?: string; bundleIdentifier?: string; bundlePath?: string }
}

let nativePaste: NativePasteAddon | null = null
let nativePasteLoadError: string | null = null
let nativePasteLogged = false

function getNativePaste(): NativePasteAddon | null {
  if (nativePaste) return nativePaste
  if (nativePasteLoadError) return null // already tried and failed
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const addon = require('unmute-native-paste') as NativePasteAddon
    if (
      typeof addon?.isAccessibilityTrusted !== 'function' ||
      typeof addon?.postCmdV !== 'function'
    ) {
      nativePasteLoadError = 'addon shape invalid (missing required exports)'
      console.warn(`[native-paste] load OK but ${nativePasteLoadError} — falling back to osascript`)
      return null
    }
    nativePaste = addon
    // Diagnostic dump on first successful load — only logged once per process.
    try {
      const info = addon.processInfo()
      const ax = addon.isAccessibilityTrusted()
      console.log(
        `[native-paste] addon loaded\n` +
        `  pid:                ${info.pid}\n` +
        `  executablePath:     ${info.executablePath ?? '?'}\n` +
        `  bundleIdentifier:   ${info.bundleIdentifier ?? '?'}\n` +
        `  bundlePath:         ${info.bundlePath ?? '?'}\n` +
        `  AXIsProcessTrusted: ${ax}`,
      )
      if (!ax) {
        console.warn(
          `[native-paste] WARNING: Accessibility not granted to this bundle. ` +
          `Native paste will fail until the user adds the .app to System Settings → ` +
          `Privacy & Security → Accessibility. We'll fall back to osascript silently.`,
        )
      }
    } catch (e) {
      console.warn(`[native-paste] diagnostic dump failed: ${e instanceof Error ? e.message : e}`)
    }
    return nativePaste
  } catch (e) {
    nativePasteLoadError = e instanceof Error ? e.message : String(e)
    console.warn(
      `[native-paste] require('unmute-native-paste') failed — falling back to osascript. Reason: ${nativePasteLoadError}`,
    )
    return null
  }
}

/**
 * Try to paste via the native CGEvent addon. Returns the time taken
 * in ms on success, or null if we should fall back to osascript.
 * Logs the per-step result object on every call so failures are
 * fully diagnostic (no silent drops).
 */
function tryNativePaste(): number | null {
  const addon = getNativePaste()
  if (!addon) return null
  const t0 = Date.now()
  let result: NativePasteResult
  try {
    result = addon.postCmdV()
  } catch (e) {
    console.warn(
      `[native-paste] postCmdV threw — falling back to osascript: ${e instanceof Error ? e.message : e}`,
    )
    return null
  }
  const dt = Date.now() - t0

  if (!result.ok) {
    // Log full breakdown so we know exactly which step refused.
    console.warn(
      `[native-paste] postCmdV NOT OK in ${dt}ms:\n` +
      `  ax_trusted:     ${result.ax_trusted}\n` +
      `  source_created: ${result.source_created}\n` +
      `  events_created: ${result.events_created}\n` +
      `  posted:         ${result.posted}\n` +
      `  stepFailed:     ${result.stepFailed ?? '?'}\n` +
      `  error:          ${result.error ?? '?'}\n` +
      `  → falling back to osascript`,
    )
    return null
  }

  // Successful path — log the breakdown once per process at info level,
  // then just a single-line summary on subsequent calls (to keep logs clean).
  if (!nativePasteLogged) {
    nativePasteLogged = true
    console.log(
      `[native-paste] postCmdV ok in ${dt}ms (first call — subsequent calls log compact)\n` +
      `  ax_trusted:     ${result.ax_trusted}\n` +
      `  source_created: ${result.source_created}\n` +
      `  events_created: ${result.events_created}\n` +
      `  posted:         ${result.posted}`,
    )
  } else {
    console.log(`[native-paste] postCmdV ok in ${dt}ms`)
  }
  return dt
}

/**
 * Get the path to the key-poster binary.
 * In packaged app: Contents/Resources/bin/key-poster
 * In dev: resources/bin/key-poster
 */
function getKeyPosterPath(): string | null {
  const candidates = [
    path.join(process.resourcesPath || '', 'bin', 'key-poster'),
    path.join(app.getAppPath(), 'resources', 'bin', 'key-poster'),
    path.join(__dirname, '..', '..', 'resources', 'bin', 'key-poster'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Simulate a keyboard shortcut.
 *
 * For PASTE (Cmd+V): try `key-poster` (CGEvent, ~15ms) first, fall back to
 * osascript (~180ms) on any non-zero exit. key-poster runs as a child of the
 * signed unmute.app bundle and inherits its Accessibility grant, so the
 * CGEvent post actually lands. Saves ~150ms per paste in shipped DMGs.
 *
 * For COPY (Cmd+C): keep osascript. Copy already has a clipboard-read verify
 * upstream (`captureSelectedText`), and CGEvent-based copy historically dropped
 * silently — the verify would catch it but it's wasted work.
 *
 * In dev mode, the parent process is bare Electron from node_modules — it
 * does NOT have Accessibility, so key-poster's CGEvent will silently drop and
 * we'll fall through to osascript. That's expected; production is the win.
 */
async function simulateKeyCombo(key: string, modifier: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Key simulation not implemented for this platform')
  }

  // For paste (Cmd+V), try the native CGEvent addon first. It runs IN-PROCESS
  // in main, so TCC checks the signed .app bundle's identity (which IS granted
  // Accessibility) — unlike the previous key-poster attempt which was a
  // separate child binary with its own identity and got silently denied.
  //
  // Native addon path: ~30 ms typical. Falls back to osascript (~200 ms) on
  // any of: addon missing, addon load failed, AXIsProcessTrusted=false,
  // CGEventSourceCreate failed, or CGEventPost threw.
  //
  // For Cmd+C and other modifiers, keep osascript — the addon currently only
  // implements postCmdV (single function, single purpose). Adding more keys
  // is a one-export-per-key extension when/if we need it.
  if (key === 'v' && modifier === 'command') {
    const nativeMs = tryNativePaste()
    if (nativeMs != null) {
      console.log(`[clipboard] paste via native addon ok in ${nativeMs}ms`)
      return
    }
    // Fell through — paste failed at the native layer. tryNativePaste()
    // already logged the reason in detail; just note we're falling back.
    const t1 = Date.now()
    await simulateViaOsascript(key, modifier)
    console.log(`[clipboard] paste via osascript (native fallback) ok in ${Date.now() - t1}ms`)
    return
  }

  const t0 = Date.now()
  await simulateViaOsascript(key, modifier)
  console.log(`[clipboard] ${key} via osascript ok in ${Date.now() - t0}ms`)
}

function simulateViaKeyPoster(command: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!command) {
      reject(new Error('No key-poster command'))
      return
    }
    const binaryPath = getKeyPosterPath()
    if (!binaryPath) {
      reject(new Error('key-poster binary not found'))
      return
    }
    execFile(binaryPath, [command], (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`key-poster exit ${err.code ?? 'err'}${stderr ? `: ${stderr.trim()}` : ''}`))
      } else {
        resolve()
      }
    })
  })
}

function simulateViaOsascript(key: string, modifier: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = `tell application "System Events" to keystroke "${key}" using ${modifier} down`
    // Use execFile to skip shell overhead (~10-20ms faster than exec)
    execFile('/usr/bin/osascript', ['-e', script], (err, _stdout, stderr) => {
      if (err) {
        console.error(`[clipboard] osascript error:`, err.message, stderr ? `stderr: ${stderr}` : '')
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

/**
 * Try to capture selected text from the active application.
 *
 * Strategy:
 * 1. First, try simulating Cmd+C via globe-listener/osascript (requires Accessibility permission)
 * 2. If that fails, fall back to reading the current clipboard contents
 *    (user must have manually copied text with Cmd+C before triggering)
 *
 * @param useClipboardFallback If true, reads clipboard as fallback when osascript fails
 */
export async function captureSelectedText(useClipboardFallback: boolean = false): Promise<string | null> {
  try {
    // Save current clipboard content
    const savedClipboard = clipboard.readText()
    console.log('[clipboard] Current clipboard length:', savedClipboard.length)

    // Clear clipboard to detect if Cmd+C actually copies something new
    clipboard.writeText('')
    noteOurWrite() // (1) ours — the clear

    // Try to simulate Cmd+C
    try {
      await simulateKeyCombo('c', 'command')
      // (2) THE ONE THAT IS EASY TO MISS. The copy above is CAUSED by us but
      // PERFORMED by System Events in another process, so its counter value
      // cannot be known in advance — it can only be read once the child has
      // completed. Miss it and the user's current selection is inserted at the
      // top of EVERY SINGLE DICTATION, which is precisely the corruption this
      // whole design exists to prevent.
      noteOurWrite()
      // Wait for clipboard to update
      await sleep(150)

      // Read the new clipboard content
      const selectedText = clipboard.readText()
      console.log('[clipboard] After Cmd+C, clipboard length:', selectedText.length, 'text:', selectedText ? JSON.stringify(selectedText.substring(0, 80)) : 'empty')

      // Restore original clipboard
      clipboard.writeText(savedClipboard)
      noteOurWrite() // (3) ours — the restore

      // If clipboard is still empty, nothing was selected
      if (!selectedText || selectedText.trim() === '') {
        console.log('[clipboard] No text was selected via Cmd+C')
        return null
      }

      return selectedText
    } catch {
      // Simulation failed — Accessibility not granted
      console.log('[clipboard] Cmd+C simulation failed (Accessibility permission needed)')

      // Restore clipboard (we cleared it above)
      clipboard.writeText(savedClipboard)
      noteOurWrite() // (3b) ours — the restore on the FAILURE branch, which
      // still writes. A write that skips its record is indistinguishable from
      // a user copy, so every branch that writes must announce itself.

      // Fallback: use clipboard contents as context if requested
      if (useClipboardFallback && savedClipboard && savedClipboard.trim() !== '') {
        console.log('[clipboard] Using clipboard contents as context (fallback), length:', savedClipboard.length)
        console.log('[clipboard] Clipboard preview:', JSON.stringify(savedClipboard.substring(0, 100)))
        return savedClipboard
      }

      return null
    }
  } catch (err) {
    console.error('[clipboard] Failed to capture selected text:', err)
    return null
  }
}

/**
 * Ensure the output text has a leading and trailing space so it doesn't
 * collide with adjacent words when pasted inline. Skips padding if the
 * text already starts/ends with whitespace.
 */
function padOutput(text: string): string {
  if (!text) return text
  let padded = text
  if (!/^\s/.test(padded)) padded = ' ' + padded
  return padded
}

// ─── Output mode ─────────────────────────────────────────────────
//
// 'paste'      → write to clipboard + simulate Cmd+V at the cursor (default)
// 'clipboard'  → write to clipboard only; user pastes manually with Cmd+V
//
// Owned by paywall-glue.ts (which has the electron-store instance). It calls
// setOutputMode() at startup with the persisted value and on every IPC
// change, so the gate is in effect from the very first dictation of a
// session.

let outputMode: 'paste' | 'clipboard' = 'paste'

export function setOutputMode(mode: 'paste' | 'clipboard'): void {
  outputMode = mode
  console.log('[clipboard] outputMode →', mode)
}

export function getOutputMode(): 'paste' | 'clipboard' {
  return outputMode
}

export async function injectOutput(text: string): Promise<void> {
  const tStart = Date.now()
  // No staged-screenshot consume here any more. Images captured during a
  // dictation are INSERTS in the capture buffer now, positioned where they
  // happened, and they are delivered by the capture seam — not appended blind
  // after the text. (Task 13 removes the old ledger itself.)
  const padded = padOutput(text)
  clipboard.writeText(padded)
  noteOurWrite() // ours — delivery's own write, synchronous with it
  console.log(`[clipboard] writeText (${padded.length} chars) in ${Date.now() - tStart}ms`)

  if (outputMode === 'clipboard') {
    console.log('[clipboard] outputMode=clipboard — skipping auto-paste, user will Cmd+V')
    return
  }

  // Brief wait so the pasteboard write is observable to the target app before
  // we post Cmd+V. TEXT MUST BE INSTANT — no verification here.
  //
  // THE OLD RACE IS GONE BECAUSE NOTHING IS CONSUMED ANY MORE, not because
  // anything is cleared. This comment used to justify the bare sleep with "any
  // consumed screenshot is CLEARED from the clipboard at key-lift" — that clear
  // (secureAndClearClipboard) was deleted with the staging ledger, and §9b rule
  // 4 says it is never coming back: we do not destroy the user's clipboard for
  // our own convenience. What makes the bare sleep correct now is simpler and
  // needs no cooperation from anyone: `writeText` above REPLACES whatever was on
  // the pasteboard, image included, and it is the last write before the ⌘V. An
  // image captured during the dictation was rescued into the pad's own storage
  // the instant it was detected (§9b rule 1), so nothing downstream depends on
  // the pasteboard still holding it. (Own-process readText cannot verify
  // cross-process propagation; polling it was proven useless.)
  await sleep(8)

  try {
    await simulateKeyCombo('v', 'command')
    console.log(`[clipboard] injectOutput total: ${Date.now() - tStart}ms`)
  } catch (err) {
    console.error(`[clipboard] Auto-paste FAILED after ${Date.now() - tStart}ms:`, err instanceof Error ? err.message : err)
    console.log('[clipboard] Text is in clipboard, user can Cmd+V manually')
  }
}

export function copyToClipboard(text: string): void {
  const padded = padOutput(text)
  clipboard.writeText(padded)
  noteOurWrite() // ours — the clipboard-mode delivery write
  console.log('[clipboard] Text copied to clipboard (padded), length:', padded.length)
}
