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
  start: () => void
  stop: () => void
}

export const POLL_MS = 250

export function createClipboardWatch(deps: ClipboardWatchDeps): ClipboardWatch {
  const ledger = createLedger()
  let armed = false
  let padDir = ''
  let lastSeen = -1
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
        const path = await deps.rescueImage(padDir)
        if (path) deps.onInsert({ kind: 'image', content: path, atMs: seenAt })
        return
      }
      const text = deps.readText()
      if (!text.trim()) return
      deps.onInsert({ kind: classifyText(text, deps.exists), content: text, atMs: seenAt })
    } finally {
      busy = false
    }
  }

  return {
    arm, disarm, noteOwnWrite, tick,
    start() { if (!timer) timer = setInterval(() => { void tick() }, POLL_MS) },
    stop() { if (timer) { clearInterval(timer); timer = null } },
  }
}
