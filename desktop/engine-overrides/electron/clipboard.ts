import { clipboard, app } from 'electron'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { keyListener } from './keyListener'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

  // key-poster (CGEvent from a child binary) silently dropped in testing even
  // on signed + notarized builds — macOS TCC tracks Accessibility per-binary
  // and the child binary's CGEvent.post() returned exit code 0 (success) but
  // the keystroke never reached the foreground app. osascript routes through
  // System Events which is system-trusted and reliably delivers the keystroke,
  // so we use it for both copy and paste.
  //
  // Reclaiming the ~150ms paste win requires posting CGEvent from the MAIN
  // Electron process (which has the signed .app bundle's TCC grant), not
  // from a separately-signed child binary. That needs a native addon and is
  // a separate piece of work.
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

    // Try to simulate Cmd+C
    try {
      await simulateKeyCombo('c', 'command')
      // Wait for clipboard to update
      await sleep(150)

      // Read the new clipboard content
      const selectedText = clipboard.readText()
      console.log('[clipboard] After Cmd+C, clipboard length:', selectedText.length, 'text:', selectedText ? JSON.stringify(selectedText.substring(0, 80)) : 'empty')

      // Restore original clipboard
      clipboard.writeText(savedClipboard)

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

export async function injectOutput(text: string): Promise<void> {
  const tStart = Date.now()
  const padded = padOutput(text)
  clipboard.writeText(padded)
  console.log(`[clipboard] writeText (${padded.length} chars) in ${Date.now() - tStart}ms`)

  // Brief wait so the pasteboard write is observable to the target app before
  // we post Cmd+V — defeats a cross-process pasteboard-sync race that can
  // otherwise cause the paste to pick up stale clipboard content.
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
  console.log('[clipboard] Text copied to clipboard (padded), length:', padded.length)
}
