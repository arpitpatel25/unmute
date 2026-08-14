import { clipboard, app, nativeImage } from 'electron'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { keyListener } from './keyListener'
import { handOffImages, pasteboardServesReadablePNG, VERIFY_TIMEOUT_MS, type PasteModifier } from './pasteboardHandoff'
import { HistoryPasteStage } from './historyPasteStage'
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
  /** Ctrl-V. Only the IMAGE steps use it, and only into a terminal — see
   *  `imagePasteModifier`. Optional on the type so an OLDER .node binary that
   *  predates it degrades to the osascript fallback instead of throwing. */
  postCtrlV?(): NativePasteResult
  processInfo(): { pid: number; executablePath?: string; bundleIdentifier?: string; bundlePath?: string }
  /** Bundle id of the frontmost app, or null. Optional for the same reason. */
  frontmostBundleId?(): string | null
  /** NSPasteboard.changeCount, used to invalidate a staged History paste when
   *  anything else was copied before Cmd+V. */
  clipboardChangeCount?(): number
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
 * Ask the addon which app is frontmost. In-process NSWorkspace property read
 * (microseconds) — no child process, no AX walk, nothing that could stall the
 * main thread. Returns null when the addon is unavailable or too old to have
 * the export, which callers read as "unknown destination" → ⌘V.
 *
 * NEVER CALLED ON THE TEXT FAST PATH. Its only caller is the image hand-off,
 * which does not run at all when nothing was captured.
 */
function readFrontmostBundleId(): string | null {
  const addon = getNativePaste()
  if (!addon || typeof addon.frontmostBundleId !== 'function') return null
  try {
    return addon.frontmostBundleId() ?? null
  } catch (e) {
    console.warn(`[native-paste] frontmostBundleId threw: ${e instanceof Error ? e.message : e}`)
    return null
  }
}

/**
 * Try to paste via the native CGEvent addon. Returns the time taken
 * in ms on success, or null if we should fall back to osascript.
 * Logs the per-step result object on every call so failures are
 * fully diagnostic (no silent drops).
 */
function tryNativePaste(modifier: PasteModifier): number | null {
  const addon = getNativePaste()
  if (!addon) return null
  // A .node binary built before postCtrlV existed has no such export. Falling
  // back to osascript is correct there — `keystroke "v" using control down`
  // posts the same keystroke, just slower.
  const post = modifier === 'control' ? addon.postCtrlV : addon.postCmdV
  const label = modifier === 'control' ? 'postCtrlV' : 'postCmdV'
  if (typeof post !== 'function') {
    console.warn(`[native-paste] addon has no ${label} — falling back to osascript`)
    return null
  }
  const t0 = Date.now()
  let result: NativePasteResult
  try {
    result = post.call(addon)
  } catch (e) {
    console.warn(
      `[native-paste] ${label} threw — falling back to osascript: ${e instanceof Error ? e.message : e}`,
    )
    return null
  }
  const dt = Date.now() - t0

  if (!result.ok) {
    // Log full breakdown so we know exactly which step refused.
    console.warn(
      `[native-paste] ${label} NOT OK in ${dt}ms:\n` +
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
      `[native-paste] ${label} ok in ${dt}ms (first call — subsequent calls log compact)\n` +
      `  ax_trusted:     ${result.ax_trusted}\n` +
      `  source_created: ${result.source_created}\n` +
      `  events_created: ${result.events_created}\n` +
      `  posted:         ${result.posted}`,
    )
  } else {
    console.log(`[native-paste] ${label} ok in ${dt}ms`)
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
  // Ctrl+V takes the same route, for the same reason — it is the paste an
  // IMAGE uses when the destination is a terminal (see `imagePasteModifier`).
  // Only the modifier flag differs inside the addon.
  //
  // For Cmd+C and other modifiers, keep osascript — the addon implements the
  // two V posts and nothing else. Adding more keys is a one-export-per-key
  // extension when/if we need it.
  if (key === 'v' && (modifier === 'command' || modifier === 'control')) {
    const nativeMs = tryNativePaste(modifier)
    if (nativeMs != null) {
      console.log(`[clipboard] paste (${modifier}) via native addon ok in ${nativeMs}ms`)
      return
    }
    // Fell through — paste failed at the native layer. tryNativePaste()
    // already logged the reason in detail; just note we're falling back.
    const t1 = Date.now()
    await simulateViaOsascript(key, modifier)
    console.log(`[clipboard] paste (${modifier}) via osascript (native fallback) ok in ${Date.now() - t1}ms`)
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

/** Ask a SEPARATE process whether the system pasteboard serves a non-empty PNG
 *  (`clipboard info` is a tiny metadata listing — no image data crosses).
 *  macOS may re-encode the image, so byte equality is not a valid readiness
 *  check. Resolves true on semantic confirmation and false on timeout.
 *
 *  IT HAS TO BE ANOTHER PROCESS. An own-process `clipboard.readImage()`
 *  reflects our own write the instant it happens and proves nothing about what
 *  the app receiving ⌘V can see; polling it was tried and proven useless. */
function verifyPasteboardServesPNG(
  timeoutMs: number,
  observe?: (fields: Record<string, unknown>) => void,
): Promise<boolean> {
  const startedAt = Date.now()
  const deadline = Date.now() + timeoutMs
  let attempts = 0
  return new Promise((resolve) => {
    const attempt = () => {
      attempts++
      // Keep each child comfortably inside the overall readiness deadline.
      // A wedged osascript must not turn the nominal 900 ms verifier into a
      // multi-second delivery stall.
      execFile('osascript', ['-e', 'clipboard info'], { timeout: Math.max(1, Math.min(timeoutMs, 400)) }, (err, stdout) => {
        if (!err && stdout) {
          // e.g. "«class PNGf», 2189440, TIFF picture, 9640988"
          if (pasteboardServesReadablePNG(stdout)) {
            const systemPNGBytes = Number(/«class PNGf»,\s*(\d+)/.exec(stdout)?.[1] ?? 0)
            observe?.({ ok: true, attempts, elapsedMs: Date.now() - startedAt, systemPNGBytes })
            resolve(true)
            return
          }
        }
        if (Date.now() >= deadline) {
          observe?.({
            ok: false, attempts, elapsedMs: Date.now() - startedAt,
            error: err ? err.message : 'png-representation-missing-or-empty',
          })
          resolve(false)
          return
        }
        setTimeout(attempt, 60)
      })
    }
    attempt()
  })
}

/** IMAGES ARRIVE AT THE CURSOR AS IMAGES, and they arrive after the text.
 *
 *  A plain text field cannot hold a file path, so an image captured during a
 *  dictation is delivered the only way a text field can accept one: through the
 *  pasteboard, with its own paste keystroke. Text first, then each image in
 *  order — a Slack message reads and then shows, which is the pre-branch
 *  behaviour and the one the user is used to.
 *
 *  WHICH keystroke depends on where it is going, and `imagePasteModifier` owns
 *  that call: ⌘V everywhere except a terminal, where it is Ctrl-V because a
 *  terminal emulator swallows ⌘V and hands the TUI text-or-nothing. The
 *  destination is read here, from the addon, and only when there are images.
 *
 *  The ORDER of the steps is the whole correctness argument, and it lives in
 *  pasteboardHandoff.ts where it can be tested without a pasteboard. This
 *  function only supplies the effects — and every one of the three that writes
 *  records the write in the same statement, because `noteOurWrite` reads the
 *  change counter at call time and anything suspended in between lets the
 *  watcher read our own write as a user copy. */
async function deliverImagesAfterText(images: readonly string[], padded: string): Promise<void> {
  return serializeImageHandoff(async () => {
  const t0 = Date.now()
  const pasted = await handOffImages<Electron.NativeImage>({
    // ONE DECODE PER IMAGE, and it happens here — before the pre-clear, and
    // outside the clear→write window. The SAME NativeImage is measured and
    // written, exactly as adb845f did it. The byte count is diagnostic only;
    // macOS may re-encode the system pasteboard representation. A second
    // createFromPath between the clear and the write would leave the system
    // pasteboard empty for the length of a Retina decode.
    prepareImage: (p: string) => {
      const img = nativeImage.createFromPath(p)
      if (img.isEmpty()) return null
      return { image: img, bytes: img.toPNG().length }
    },
    clearAndRecord: () => { clipboard.clear(); noteOurWrite() },
    writeImageAndRecord: (img: Electron.NativeImage) => { clipboard.writeImage(img); noteOurWrite() },
    writeTextAndRecord: (t: string) => { clipboard.writeText(t); noteOurWrite() },
    verifyServesPNG: () => verifyPasteboardServesPNG(VERIFY_TIMEOUT_MS, (fields) => {
      if (process.env.UNMUTE_CURATOR_DEVLOG === '1') console.log('[clipboard] pasteboard-system-read', fields)
    }),
    frontmostBundleId: readFrontmostBundleId,
    paste: (modifier: PasteModifier) => simulateKeyCombo('v', modifier),
    settle: sleep,
    warn: (m: string, err?: unknown) => console.warn(m, err instanceof Error ? err.message : err ?? ''),
  }, images, padded)
  console.log(`[clipboard] pasted ${pasted}/${images.length} captured image(s) in ${Date.now() - t0}ms`)
  })
}

let imageHandoffChain: Promise<unknown> = Promise.resolve()
function serializeImageHandoff<T>(runEffect: () => Promise<T>): Promise<T> {
  const run = imageHandoffChain.then(runEffect)
  imageHandoffChain = run.catch(() => {})
  return run
}

/** Hand real pasteboard images to an owned task rather than the frontmost app.
 * The callback writes Ctrl-V into the exact PTY selected at capture start, so
 * focus changes cannot redirect an addressed reply. */
export async function injectImagesIntoTask(
  _text: string,
  images: readonly string[],
  paste: () => Promise<boolean>,
  observe?: (stage: string, fields: Record<string, unknown>) => void,
): Promise<boolean> {
  if (!images.length) return true
  return serializeImageHandoff(async () => {
    const restoreText = clipboard.readText()
    const restoreImage = clipboard.readImage()
    const restoreHasImage = !restoreImage.isEmpty()
    const pasted = await handOffImages<Electron.NativeImage>({
    prepareImage: (p: string) => {
      const img = nativeImage.createFromPath(p)
      if (img.isEmpty()) return null
      return { image: img, bytes: img.toPNG().length }
    },
    clearAndRecord: () => { clipboard.clear(); noteOurWrite() },
    writeImageAndRecord: (img: Electron.NativeImage) => { clipboard.writeImage(img); noteOurWrite() },
    writeTextAndRecord: (t: string) => { clipboard.writeText(t); noteOurWrite() },
    verifyServesPNG: () => verifyPasteboardServesPNG(VERIFY_TIMEOUT_MS, (fields) => {
      try { observe?.('pasteboard-system-read', fields) } catch { /* diagnostics never alter delivery */ }
    }),
    frontmostBundleId: () => null,
    paste: async () => {
      if (!(await paste())) throw new Error('target did not accept clipboard image')
    },
    settle: sleep,
    warn: (m: string, err?: unknown) => console.warn(m, err instanceof Error ? err.message : err ?? ''),
    observe,
    }, images, restoreText)
    if (restoreHasImage) {
      clipboard.write({ text: restoreText, image: restoreImage })
      noteOurWrite()
    }
    return pasted === images.length
  })
}

/** Hand images to a desktop composer through the pasteboard.
 *
 * `paste` is how the staged image is consumed. A driver that can reach its
 * target's renderer supplies one — that paste needs no focus, so the caller
 * owns addressing only. Without it we fall back to a native Command-V, which
 * goes to whichever app is frontmost and therefore makes focus the caller's
 * problem too. */
export async function injectImagesIntoDesktopTask(
  text: string,
  images: readonly string[],
  observe?: (stage: string, fields: Record<string, unknown>) => void,
  paste?: () => Promise<boolean>,
): Promise<boolean> {
  return injectImagesIntoTask(text, images, paste ?? (async () => {
    await simulateKeyCombo('v', 'command')
    return true
  }), observe)
}

const historyPasteStage = new HistoryPasteStage()

function currentClipboardIdentity(): { changeCount: number | null; text: string } {
  let changeCount: number | null = null
  try {
    const value = getNativePaste()?.clipboardChangeCount?.()
    if (typeof value === 'number' && value >= 0) changeCount = value
  } catch { /* the text comparison remains as a safe fallback */ }
  let text = ''
  try { text = clipboard.readText() } catch { /* an unreadable board cannot match */ }
  return { changeCount, text }
}

/** Stage a History record for the user's next physical Cmd+V.
 *
 * Text stays on the real pasteboard and is pasted by macOS. The key listener
 * merely observes that keystroke; after the target has consumed the text, the
 * exact same image sequencer used by live dictation appends each image. */
export function stageHistoryPaste(text: string, images: readonly string[]): void {
  clipboard.writeText(text)
  noteOurWrite()
  if (!images.length) {
    historyPasteStage.clear()
    return
  }
  historyPasteStage.set({ text, images }, currentClipboardIdentity())
  console.log(`[clipboard] staged History paste (${text.length} chars, ${images.length} image(s))`)
}

keyListener.on('key', (event) => {
  if (event !== 'command-v') return
  const composition = historyPasteStage.take(currentClipboardIdentity())
  if (!composition?.images.length) return
  // The physical Cmd+V is not intercepted: macOS is already delivering the
  // text. handOffImages begins with its own settle interval, then appends the
  // archived images and restores the text to the clipboard when finished.
  void deliverImagesAfterText(composition.images, composition.text).catch((err) => {
    console.warn('[clipboard] History image handoff skipped:', err instanceof Error ? err.message : err)
  })
})

export async function injectOutput(text: string, images?: readonly string[]): Promise<void> {
  const tStart = Date.now()
  // Images captured during a dictation are INSERTS in the capture buffer,
  // positioned where they happened; the capture seam renders them out as
  // `attachments` and hands them here. Nothing is swept off the clipboard
  // blind, and nothing is appended without the user having captured it.
  const padded = padOutput(text)
  clipboard.writeText(padded)
  noteOurWrite() // ours — delivery's own write, synchronous with it
  console.log(`[clipboard] writeText (${padded.length} chars) in ${Date.now() - tStart}ms`)

  if (outputMode === 'clipboard') {
    console.log('[clipboard] outputMode=clipboard — skipping auto-paste, user will Cmd+V')
    // No ⌘V is synthesised at all in this mode, so there is no second paste to
    // sequence against and nowhere for an image to land. The text stays on the
    // pasteboard for the user, exactly as it does today.
    if (images?.length) {
      console.log(`[clipboard] outputMode=clipboard — ${images.length} captured image(s) left in the pad`)
    }
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

  // The images the user captured during this dictation, after the text and in
  // order. Fail-open in every direction: the text is already delivered above,
  // and nothing in here may reach the dictation path.
  if (images?.length) {
    try {
      await deliverImagesAfterText(images, padded)
    } catch (err) {
      console.warn('[clipboard] captured-image delivery skipped:', err instanceof Error ? err.message : err)
    }
  }
}

export function copyToClipboard(text: string): void {
  const padded = padOutput(text)
  clipboard.writeText(padded)
  noteOurWrite() // ours — the clipboard-mode delivery write
  console.log('[clipboard] Text copied to clipboard (padded), length:', padded.length)
}
