// The single object main talks to. Everything below it is pure and tested;
// this composes it and owns the two watchers' arm/disarm lifecycle.
//
// ARM ON RECORD, DISARM ON STOP. Capture happens only while the mic is hot —
// the recording window IS the consent signal, and stopping closes it. Neither
// watcher ever runs outside a window the user deliberately opened.
//
// THE FAST PATH MUST NOT MOVE. Unarmed, with nothing copied, every export here
// is either inert or a boolean read. Nothing in this module may make an
// ordinary tap-talk-tap-paste dictation produce different bytes.

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Destination, InsertKind, Pad } from './types'
import { padDirFor, serialize } from './scratchpadStore'
import { createClipboardWatch } from './clipboardWatch'
import { createScreenshotWatch } from './screenshotWatch'
import {
  addInsert, addSegment, emptyPad, isEmpty, removeEntry, setSegmentText,
} from './captureBuffer'
import { render, type RenderResult } from './insertRender'
import { canArmScratchpad, type CaptureSettings } from './captureGate'
import { claimContent, createLedger } from './clipboardLedger'

/** Where pads live on disk. Unmute-owned, safe to delete, recreated on demand. */
export const SCRATCHPAD_ROOT = join(homedir(), '.unmute', 'remote', 'scratchpad')

/** Overridable so tests never touch the user's real scratchpad. */
let scratchpadRoot = SCRATCHPAD_ROOT
export function setScratchpadRoot(root: string): void { scratchpadRoot = root }

let pad: Pad | null = null
let armed = false
let openSegmentId: string | null = null
let captureStartedAt = 0

// Both detectors claim against ONE ledger, because a tool set to write a file
// AND copy fires each of them for a single user action. It lives HERE, not in
// init.ts, because recordInsert is the one point the two detectors converge.
const sharedLedger = createLedger()

/** The screenshot watcher's path-keyed claim. Exposed so init.ts can hand it to
 *  createScreenshotWatch without owning a second ledger. */
export function claimShared(hash: string, atMs: number): boolean {
  return claimContent(sharedLedger, hash, atMs)
}

// ── Injected effects ────────────────────────────────────────────────────
//
// DEPENDENCY INVERSION, NOT AN IMPORT. clipboard.ts already imports from
// remote/init, and its header records why that direction is one-way: a lazy
// require of that path fails inside the bundled main, swallowed by a fail-open
// catch ("No cycle: remote/init never imports clipboard.ts"). If the delivery
// handler imported injectOutput directly, it would close exactly that loop.
//
// So the paste effect is REGISTERED by the module that already owns it
// (sessionManager, which imports injectOutput today) and called back through
// here. No new edge in the import graph.

type PasteFn = (text: string) => Promise<void>
let pasteFn: PasteFn | null = null

export function registerPaste(fn: PasteFn): void { pasteFn = fn }

export async function pasteAtCursor(text: string): Promise<boolean> {
  if (!pasteFn) return false
  await pasteFn(text)
  return true
}

/** Read at capture start so a mid-capture settings change cannot make a
 *  half-observed window. Registered the same way, for the same reason. */
type SettingsFn = () => CaptureSettings
let settingsFn: SettingsFn | null = null

export function registerSettings(fn: SettingsFn): void { settingsFn = fn }

export function getCaptureSettings(): CaptureSettings {
  try {
    return settingsFn?.() ?? { scratchpadEnabled: true, captureEnabled: true }
  } catch {
    return { scratchpadEnabled: true, captureEnabled: true }
  }
}

export function isArmed(): boolean { return armed }
export function currentPad(): Pad | null { return pad }

/** Arm/disarm the scratchpad. Returns the resulting state — arming is refused
 *  when the feature is off, so callers see what actually happened.
 *
 *  Arming BETWEEN captures starts fresh: a pad left over from an unarmed
 *  capture is somebody else's dictation, and it must not become the first
 *  thing the user's new pad contains. Arming DURING a capture (openSegmentId
 *  is set) keeps what is being said right now — that is the whole gesture. */
export function armScratchpad(on: boolean): boolean {
  if (on && !armed && pad && !openSegmentId) discard()
  armed = on ? canArmScratchpad(getCaptureSettings()) : false
  // Now that it is held, it becomes worth writing down.
  if (armed) schedulePersist()
  return armed
}

/** Test/lifecycle escape hatch. Prefer armScratchpad, which honours the gate. */
export function setArmed(on: boolean): void { armed = on }

/** A capture began.
 *
 *  An ARMED pad survives between captures and the next one appends to it —
 *  that is the whole point of the scratchpad. An UNARMED pad does not: nothing
 *  consumes it (delivery goes through the ordinary dictation path), so leaving
 *  it behind would let one dictation's speech leak into the next one's pad.
 *  Dropping it at the capture boundary makes that impossible on EVERY terminal
 *  path — including the ones that never reach delivery at all (too-short,
 *  empty transcript, API error, cancel). */
export function beginSegment(origin: Destination, now: number, observe: boolean): string {
  if (pad && !armed) discardPadFiles(pad)
  if (!armed) pad = null
  if (!pad) pad = emptyPad(randomUUID(), origin, now)
  captureStartedAt = now
  openSegmentId = randomUUID()
  pad = addSegment(pad, { id: openSegmentId, text: '', startMs: 0, endMs: 0, now })
  armWatchers(padDirFor(scratchpadRoot, pad.id), observe)
  schedulePersist()
  return openSegmentId
}

export function endSegment(now: number): void {
  disarmWatchers()
  openSegmentId = null
  if (pad) { pad = { ...pad, updatedAt: now }; schedulePersist() }
}

/** Transcription lands 30-45s after the audio, so text is attached later.
 *
 *  If the segment is GONE — Escape drops the open segment, and undo then
 *  re-processes the same audio — the text is appended as a new segment rather
 *  than dropped. setSegmentText is a silent no-op on an unknown id, and a
 *  silent no-op here would mean an armed stop held an empty pad and the user's
 *  words went nowhere at all. */
export function attachTranscript(segmentId: string | null, text: string, now: number): void {
  if (!pad) return
  const known = !!segmentId
    && pad.entries.some((e) => e.type === 'segment' && e.id === segmentId)
  pad = known
    ? setSegmentText(pad, segmentId as string, text, now)
    : addSegment(pad, { id: randomUUID(), text, startMs: 0, endMs: 0, now })
  schedulePersist()
}

/** An insert arrived from either watcher. Position is relative to capture
 *  start, so it sorts against segment times on the same clock.
 *
 *  THIS IS ALSO THE CROSS-DETECTOR DEDUP POINT, and it has to be — the two
 *  watchers cannot dedup against each other from where they sit. A tool set to
 *  write a file AND copy (CleanShot, Shottr) fires BOTH for one user action,
 *  but they hold different paths for it: the screenshot watcher has the
 *  original file, the clipboard watcher has its own freshly-rescued copy under
 *  padDir. Those strings can never be equal, so claiming on a path — which is
 *  what an earlier draft did — dedups nothing and the user gets two image
 *  inserts for one screenshot.
 *
 *  The only thing the two genuinely share is the image CONTENT. So images are
 *  claimed on a content signature here, at the one point both detectors
 *  converge, rather than in either watcher.
 *
 *  The signature is size + md5 of the first 4KB — NOT a full hash. Hashing a
 *  multi-megabyte Retina PNG on the main process while recording is exactly
 *  the heavy work that corrupts audio; reading 4KB is microseconds. */
export function recordInsert(
  i: { kind: InsertKind; content: string; atMs: number },
  now: number,
): void {
  if (!pad) return
  if (i.kind === 'image') {
    const sig = imageSignature(i.content)
    // An unreadable file yields no signature. Insert it rather than dropping
    // it — a missed dedup shows the user one extra thumbnail they can remove,
    // while a wrong drop loses something they captured on purpose.
    if (sig && !claimShared(sig, i.atMs)) return
  }
  pad = addInsert(pad, {
    id: randomUUID(), kind: i.kind, content: i.content,
    atMs: i.atMs - captureStartedAt, now,
  })
  schedulePersist()
}

/** size:md5(first 4KB). Cheap by construction — see recordInsert. */
function imageSignature(path: string): string | null {
  try {
    const st = statSync(path)
    if (!st.size) return null
    const head = Buffer.alloc(Math.min(4096, st.size))
    const fd = openSync(path, 'r')
    try { readSync(fd, head, 0, head.length, 0) } finally { closeSync(fd) }
    return `${st.size}:${createHash('md5').update(head).digest('hex')}`
  } catch { return null }
}

export function removeFromPad(id: string, now: number): void {
  if (!pad) return
  pad = removeEntry(pad, id, now)
  schedulePersist()
}

/** Render and clear. Returns null when there is nothing to send. */
export function deliver(dest: Destination): RenderResult | null {
  const p = pad
  if (!p || isEmpty(p)) { pad = null; armed = false; return null }
  const out = render(p, dest)
  pad = null
  armed = false
  // The held state is gone; the rescued FILES stay, because a delivered pad's
  // attachments are referenced by whatever received them.
  removePadState(p)
  return out
}

/** The user threw the pad away. Unlike deliver, this takes the files too. */
export function discard(): void {
  const p = pad
  pad = null
  armed = false
  openSegmentId = null
  if (p) discardPadFiles(p)
}

/** Drop the segment in progress without touching the rest of the pad. Escape
 *  must cancel an utterance, never destroy held work — discard is the only
 *  path that does that, and it confirms.
 *
 *  Also closes the capture window: the mic is cold the instant a capture is
 *  cancelled, and the watchers must never outlive it. */
export function cancelOpenSegment(now: number): void {
  disarmWatchers()
  if (pad && openSegmentId) { pad = removeEntry(pad, openSegmentId, now); schedulePersist() }
  openSegmentId = null
}

// ── Persistence ─────────────────────────────────────────────────────────
// Held work must survive a crash. The pad is written as it is built, with the
// house atomic pattern (write .tmp, then rename).
//
// COALESCED AND OFF THE HOT INSTANT: a write is scheduled, never performed
// inline, so no capture-path call ever pays for disk I/O at the moment it
// happens. The payload is a few hundred bytes of JSON.

export const PERSIST_DEBOUNCE_MS = 250

let persistTimer: ReturnType<typeof setTimeout> | null = null

function schedulePersist(): void {
  // UNARMED PADS ARE NEVER WRITTEN. Nothing is being held, so there is nothing
  // to survive a crash — and the alternative would put a mkdir + file write on
  // the main process in the middle of every ordinary dictation, which is
  // exactly the work that corrupts audio. The fast path touches no disk.
  if (!armed) return
  if (persistTimer) return
  persistTimer = setTimeout(() => { persistTimer = null; writePadNow() }, PERSIST_DEBOUNCE_MS)
  ;(persistTimer as unknown as { unref?: () => void }).unref?.()
}

/** Exposed for tests and for a deliberate flush. Never throws. */
export function writePadNow(): void {
  const p = pad
  if (!p) return
  try {
    const dir = padDirFor(scratchpadRoot, p.id)
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, 'pad.json.tmp')
    writeFileSync(tmp, serialize(p), 'utf8')
    renameSync(tmp, join(dir, 'pad.json'))
  } catch (err) {
    // A pad that cannot be written is still a pad in memory. Losing durability
    // is bad; taking the dictation down with it is worse.
    console.warn('[capture] pad persist failed:', err)
  }
}

function removePadState(p: Pad): void {
  try { rmSync(join(padDirFor(scratchpadRoot, p.id), 'pad.json'), { force: true }) } catch { /* gone */ }
}

function discardPadFiles(p: Pad): void {
  try { rmSync(padDirFor(scratchpadRoot, p.id), { recursive: true, force: true }) } catch { /* gone */ }
}

// ── Watchers ────────────────────────────────────────────────────────────
// Owned here so arm/disarm is one call from sessionManager and the two
// watchers can never drift out of step with each other or with the mic.

let clipboardWatch: ReturnType<typeof createClipboardWatch> | null = null
let screenshotWatch: ReturnType<typeof createScreenshotWatch> | null = null
/** Did THIS window actually arm the watchers? Gating on the flag (not on
 *  `pad !== null`) is what keeps rebaselineClipboard from arming a watcher the
 *  capture gate deliberately left off. */
let watchersArmed = false

export function initWatchers(
  cw: ReturnType<typeof createClipboardWatch> | null,
  sw: ReturnType<typeof createScreenshotWatch> | null,
): void {
  clipboardWatch = cw
  screenshotWatch = sw
}

/** Called by clipboard.ts immediately after any Unmute pasteboard write. */
export function noteOwnClipboardWrite(): void {
  clipboardWatch?.noteOwnWrite()
}

function armWatchers(padDir: string, observe: boolean): void {
  if (!observe) return
  try {
    clipboardWatch?.arm(padDir)
    clipboardWatch?.start()
    screenshotWatch?.arm()
    watchersArmed = true
  } catch (err) {
    console.warn('[capture] arm failed:', err)
  }
}

function disarmWatchers(): void {
  watchersArmed = false
  try {
    clipboardWatch?.stop()
    clipboardWatch?.disarm()
    screenshotWatch?.disarm()
  } catch (err) {
    console.warn('[capture] disarm failed:', err)
  }
}

/** BACKSTOP FOR OUR OWN SYNTHESISED ⌘C.
 *
 *  captureSelectedText clears the pasteboard, has ANOTHER PROCESS copy into
 *  it, then restores it — three changes, all ours, all inside a hot-mic
 *  window. They announce themselves through noteOwnClipboardWrite(), but the
 *  middle one is performed asynchronously by osascript, so there is a window
 *  in which the 250ms poll could see the user's selection land before we have
 *  recorded its counter value — and the cost of losing that race is the user's
 *  selection at the top of every dictation.
 *
 *  Re-baselining once the whole sequence has finished removes the race instead
 *  of narrowing it: arm() takes a fresh baseline, so every change up to this
 *  instant is, by construction, not a candidate. The cost is that a genuine
 *  copy made during those first few hundred milliseconds is not captured —
 *  a missed insert, against a corrupted transcript. */
export function rebaselineClipboard(): void {
  if (!watchersArmed || !pad) return
  try { clipboardWatch?.arm(padDirFor(scratchpadRoot, pad.id)) } catch (err) {
    console.warn('[capture] rebaseline failed:', err)
  }
}

/** Full reset — tests only. */
export function _resetForTest(): void {
  disarmWatchers()
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
  pad = null
  armed = false
  openSegmentId = null
  captureStartedAt = 0
  pasteFn = null
  settingsFn = null
  clipboardWatch = null
  screenshotWatch = null
  watchersArmed = false
  sharedLedger.ownWrites.clear()
  sharedLedger.claims.clear()
  scratchpadRoot = SCRATCHPAD_ROOT
}
