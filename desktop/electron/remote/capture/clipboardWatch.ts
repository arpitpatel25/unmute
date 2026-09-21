// Watch the pasteboard during a hot mic, without ever touching the audio.
//
// DETECTION AND READING ARE SEPARATE. Detection is one integer read per tick,
// which is safe on the main process while recording. Reading actual content is
// expensive (a Retina PNG decode), so it happens only when the integer moved,
// and image bytes are read by a CHILD PROCESS — never here.
//
// RESCUE IMMEDIATELY. The pasteboard is a single-slot global: copy A then copy
// B and A is gone. So content is copied into Unmute-owned storage the instant
// it is detected, and the buffer refers to our file from then on. We never read
// the clipboard twice for the same thing, and we never depend on it retaining
// anything.
//
// WE NEVER MUTATE IT. There is deliberately no clear() and no write() on this
// surface — the only Unmute pasteboard write is delivery's injectOutput, which
// announces itself through noteOwnWrite().
//
// All platform access is injected, so the logic tests without a clipboard.

import type { InsertKind } from './types'
import { classifyText } from './insertClassify'
import {
  createLedger, noteOwnWrite as ledgerNoteOwnWrite, resetLedger, shouldObserve,
} from './clipboardLedger'

export interface ClipboardWatchDeps {
  /** Monotonic pasteboard change counter; -1 when unobservable. */
  changeCount: () => number
  readText: () => string
  hasImage: () => boolean
  /** Copies the pasteboard image into padDir via a child process. Returns the
   *  destination path, or null if it could not be read. */
  rescueImage: (padDir: string) => Promise<string | null>
  exists: (p: string) => boolean
  now: () => number
  onInsert: (i: { kind: InsertKind; content: string; atMs: number }) => void
}

export interface ClipboardWatch {
  arm: (padDir: string) => void
  disarm: () => void
  /** Record that the change we just caused is ours. Call immediately after any
   *  Unmute pasteboard write. */
  noteOwnWrite: () => void
  /** One poll. Exposed so tests drive it deterministically instead of waiting. */
  tick: () => Promise<void>
  /** The user pasted the pasteboard into Unmute's own typed-input box. An
   *  image there is part of the input even when it was copied before the
   *  window opened; anything this watcher already captured is not added twice. */
  adoptCurrent: () => Promise<void>
  start: () => void
  stop: () => void
}

export const POLL_MS = 250

export function createClipboardWatch(deps: ClipboardWatchDeps): ClipboardWatch {
  const ledger = createLedger()
  let armed = false
  let padDir = ''
  let lastSeen = -1
  // The change that last produced an insert, and the last one adopted by a
  // paste. Together they make "already part of this capture" one comparison.
  let lastInserted = -1
  let adopted = -1
  let timer: ReturnType<typeof setInterval> | null = null
  let busy = false

  function arm(dir: string): void {
    padDir = dir
    resetLedger(ledger)
    // Baseline: whatever is on the pasteboard right now predates the window and
    // must never fire. Staleness stops being possible rather than being
    // defended against.
    lastSeen = deps.changeCount()
    armed = true
    lastInserted = -1
    adopted = -1
  }

  function disarm(): void {
    armed = false
    resetLedger(ledger)
  }

  function noteOwnWrite(): void {
    ledgerNoteOwnWrite(ledger, deps.changeCount())
  }

  async function tick(): Promise<void> {
    if (!armed || busy) return
    const c = deps.changeCount()
    if (c < 0 || c === lastSeen) return
    const seenAt = deps.now()
    lastSeen = c
    if (!shouldObserve(ledger, c)) return

    busy = true
    try {
      if (deps.hasImage()) {
        // The rescue is a child-process spawn — it can REJECT (spawn failure,
        // non-zero exit, IPC error), not just resolve null. A rejection must
        // never escape tick(): start()'s interval callback discards it with
        // `void`, and an unhandled rejection kills the Node process, which is
        // exactly the failure this module exists to prevent. Degrade to "no
        // insert" instead.
        //
        // If a second real copy happens while this rescue is still in flight,
        // the FIRST one is unrecoverable — the pasteboard is a single slot and
        // the newer content has already overwritten it by the time we could
        // have read the old one. That loss is inherent, not a bug: lastSeen
        // still advances to the newest changeCount, so no copy is silently
        // skipped — the earlier one was simply never readable to begin with.
        let path: string | null = null
        try {
          path = await deps.rescueImage(padDir)
        } catch {
          path = null
        }
        // The capture window may have closed (disarm()) while we were
        // awaiting the rescue. Consent is checked at delivery time too, not
        // just at detection time — an insert must never land after the mic
        // has gone cold.
        if (!armed) return
        if (path) { lastInserted = c; deps.onInsert({ kind: 'image', content: path, atMs: seenAt }) }
        return
      }
      const text = deps.readText()
      if (!text.trim()) return
      lastInserted = c
      deps.onInsert({ kind: classifyText(text, deps.exists), content: text, atMs: seenAt })
    } catch (err) {
      // A detection tick must never be able to take the process down, no
      // matter what a dep does. start()'s interval callback discards tick()'s
      // promise with `void`, so an escaping throw here — from hasImage(),
      // readText(), classifyText(), or onInsert() (e.g. a destroyed
      // BrowserWindow mid-teardown) — would be an unhandled rejection that
      // kills the Electron main process. The rescueImage() catch above stays
      // narrow (it has its own "degrade to no insert" contract); this one is
      // the backstop for everything else in the branch. Logged, not silent —
      // a dep throwing here is a real bug someone needs to be able to find.
      console.warn('[capture] clipboardWatch tick failed:', err)
    } finally {
      busy = false
    }
  }

  /**
   * A PASTE INTO THE TYPED BOX IS A CAPTURE, BUT ONLY ONCE.
   *
   * Text needs nothing here: it is already in the box, and the box is the
   * input. An image cannot live in a text field, so it has to become an insert
   * — unless this watcher already made it one, which is the ordinary case of
   * copying a screenshot during the capture and then pasting it too.
   *
   * The baseline rule in arm() cannot answer this: the selection grab restores
   * the pasteboard, which moves the change count without the content being
   * new. So the question is asked directly — did THIS change produce an insert?
   */
  async function adoptCurrent(): Promise<void> {
    if (!armed) return
    // Anything detected but not yet ticked is ordinary detection's job.
    await tick()
    const c = deps.changeCount()
    if (!armed || busy || c < 0 || c === lastInserted || c === adopted) return
    if (!deps.hasImage()) return
    adopted = c
    busy = true
    try {
      let path: string | null = null
      try { path = await deps.rescueImage(padDir) } catch { path = null }
      if (armed && path) deps.onInsert({ kind: 'image', content: path, atMs: deps.now() })
    } catch (err) {
      console.warn('[capture] clipboardWatch adopt failed:', err)
    } finally {
      busy = false
    }
  }

  return {
    arm, disarm, noteOwnWrite, tick, adoptCurrent,
    start() { if (!timer) timer = setInterval(() => { void tick() }, POLL_MS) },
    stop() { if (timer) { clearInterval(timer); timer = null } },
  }
}
