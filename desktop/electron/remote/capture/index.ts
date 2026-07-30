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
  closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Destination, InsertKind, Pad } from './types'
import { deserialize, padDirFor, serialize } from './scratchpadStore'
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

/** A pad a PREVIOUS RUN left on disk, deserialized at startup and waiting.
 *
 *  It is deliberately NOT the live pad. A settled pad must survive every
 *  ordinary dictation that happens before the user comes back to it, and the
 *  live slot cannot give it that: beginSegment drops an unarmed pad at each
 *  capture boundary, and it would append the next unarmed utterance to it
 *  besides. So held work waits HERE, out of the capture path entirely, and
 *  arming promotes it back — see armScratchpad. */
let heldPad: Pad | null = null

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

/** The output formatter, registered by the module that owns it (sessionManager,
 *  which already applies it at every ordinary delivery site).
 *
 *  Same inversion as the paste effect, for the same reason: init.ts cannot
 *  import sessionManager any more than it can import clipboard.ts. */
type FormatFn = (text: string) => string | Promise<string>
let formatFn: FormatFn | null = null

export function registerFormat(fn: FormatFn): void { formatFn = fn }

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
/** The settled pad from a previous run, if one is waiting. Null once it has
 *  been brought back (or if there never was one). */
export function settledPad(): Pad | null { return heldPad }

/** Everything a surface needs to render the scratchpad, read in one go so the
 *  pad, the arm state and the settled pad can never be sampled out of step. */
export interface ScratchpadSnapshot {
  pad: Pad | null
  armed: boolean
  held: Pad | null
}

export function snapshot(): ScratchpadSnapshot {
  return { pad, armed, held: heldPad }
}

/** Arm/disarm the scratchpad. Returns the resulting state — arming is refused
 *  when the feature is off, so callers see what actually happened.
 *
 *  ARMING IS ALSO WHAT BRINGS A SETTLED PAD BACK. A pad adopted from disk at
 *  startup waits out of the capture path (see heldPad); arming with nothing
 *  live promotes it, which is the "settle, do not nag" half of the design —
 *  the pill stays normal until the user asks for the pad again.
 *
 *  Arming BETWEEN captures otherwise starts fresh: a pad left over from an
 *  unarmed capture is somebody else's dictation, and it must not become the
 *  first thing the user's new pad contains. Arming DURING a capture
 *  (openSegmentId is set) keeps what is being said right now — the gesture.
 *
 *  The gate is evaluated FIRST so a refused arm has no side effects at all:
 *  promoting (or dropping) a pad for an arm that then fails would leave an
 *  unarmed live pad the next capture boundary throws away. */
export function armScratchpad(on: boolean): boolean {
  const next = on ? canArmScratchpad(getCaptureSettings()) : false
  if (next && !armed) {
    // Order matters: the leftover goes first, so an arm that follows an
    // ordinary dictation still brings the settled pad back rather than
    // spending itself clearing somebody else's words.
    if (pad && !openSegmentId) dropLivePad()
    if (!pad && heldPad) { pad = heldPad; heldPad = null }
  }
  armed = next
  // Now that it is held, it becomes worth writing down.
  if (armed) schedulePersist()
  return armed
}

/** Adopt a pad a previous run left on disk. Called once, at startup.
 *
 *  UNARMED AND SETTLED, always. The pill must not be pinned open by a pad the
 *  user has forgotten, and arming on their behalf would silently swallow their
 *  next dictation into work they were not thinking about. Arming again is what
 *  brings it back.
 *
 *  A pad that fails `deserialize` is skipped in silence — a corrupt file is a
 *  reason to start fresh, never a reason to fail startup. Nothing here throws:
 *  a missing root, an unreadable directory and a truncated file all mean the
 *  same thing, which is "there is nothing held".
 *
 *  The NEWEST valid pad wins. More than one can only exist if more than one run
 *  died holding work; the most recent is the one the user was in the middle of.
 *  The files are left where they are — discard is the only thing that deletes a
 *  pad, and that has not happened. */
export function adoptPersistedPad(): Pad | null {
  if (pad || heldPad) return null
  let names: string[]
  try {
    names = readdirSync(scratchpadRoot)
  } catch {
    return null // no root yet — nothing has ever been held
  }
  let best: Pad | null = null
  for (const name of names) {
    let raw: string
    try {
      raw = readFileSync(join(padDirFor(scratchpadRoot, name), 'pad.json'), 'utf8')
    } catch {
      continue // not a pad directory, or its state is gone
    }
    const p = deserialize(raw)
    // An empty pad holds nothing, so bringing it back would only be noise.
    if (!p || isEmpty(p)) continue
    if (!best || p.updatedAt > best.updatedAt) best = p
  }
  if (!best) return null
  heldPad = best
  return best
}

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
  clearOwnSequenceTimer()
  ownSequenceDepth = 0
  suppressDetectedUpTo = 0
  pad = addSegment(pad, { id: openSegmentId, text: '', startMs: 0, endMs: 0, now })
  armWatchers(padDirFor(scratchpadRoot, pad.id), observe)
  schedulePersist()
  return openSegmentId
}

export function endSegment(now: number): void {
  disarmWatchers()
  openSegmentId = null
  // The claims map is per-capture: it exists to merge two detectors reporting
  // ONE user action within a 2s window, and that question dies with the
  // window. Without this it is a Map that only ever grows, for the lifetime of
  // the main process.
  sharedLedger.claims.clear()
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
 *  the heavy work that corrupts audio; reading 4KB is microseconds.
 *
 *  RETURNS WHETHER IT RECORDED, and callers must respect that. Every refusal
 *  path here is a decision that this insert does not exist — but the caller
 *  also broadcasts the pad and pushes capture:insert-detected, and that second
 *  one reaches insertPendingRef → decideCut, i.e. THE FAST PATH'S CHUNKING. If
 *  the siblings fire unconditionally, a refused insert still moves a chunk
 *  boundary, and the pad and the signal disagree about what happened. */
export function recordInsert(
  i: { kind: InsertKind; content: string; atMs: number },
  now: number,
): boolean {
  if (!pad) return false
  // Anything SEEN while Unmute owned the pasteboard is Unmute's, not the
  // user's — see beginOwnClipboardSequence. Checked on the detection instant,
  // not on arrival, so a rescue that outlives the sequence is refused too.
  // screenshotWatch is NOT suspended and fires synchronously, so this is a
  // reachable path, not a theoretical one.
  if (ownSequenceDepth > 0 || i.atMs <= suppressDetectedUpTo) return false
  if (i.kind === 'image') {
    const sig = imageSignature(i.content)
    // An unreadable file yields no signature. Insert it rather than dropping
    // it — a missed dedup shows the user one extra thumbnail they can remove,
    // while a wrong drop loses something they captured on purpose.
    if (sig && !claimShared(sig, i.atMs)) return false
  }
  pad = addInsert(pad, {
    id: randomUUID(), kind: i.kind, content: i.content,
    atMs: i.atMs - captureStartedAt, now,
  })
  schedulePersist()
  return true
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

/** The user threw the pad away. Unlike deliver, this takes the files too —
 *  INCLUDING a settled pad's, because from the user's side there is only ever
 *  one pad: if nothing is live, the pad they mean is the one waiting to come
 *  back. Leaving it on disk would resurrect it at the next arm. */
export function discard(): void {
  dropLivePad()
  const h = heldPad
  heldPad = null
  if (h) discardPadFiles(h)
}

/** Drop the LIVE pad only. Split out because arming-between-captures throws
 *  away a leftover unarmed pad, and that must not take the settled pad with
 *  it — arming is the gesture that asks for the settled pad back. */
function dropLivePad(): void {
  const p = pad
  pad = null
  armed = false
  openSegmentId = null
  if (p) discardPadFiles(p)
}

// ── Delivery ────────────────────────────────────────────────────────────
//
// Two steps, on purpose. Taking the pad is synchronous so the surface can be
// told it is empty the instant the user commits — before any formatting
// round-trip — and formatting is awaited after.

/** Where the user chose to send it. Wider than `Destination` because "a new
 *  task" and "the task already on screen" are the same rendering but different
 *  deliveries. */
export type DeliveryTarget = 'cursor' | 'newTask' | 'openTask'

function destinationFor(target: DeliveryTarget): Destination {
  return target === 'cursor' ? 'cursor' : 'task'
}

/** The pad a delivery has TAKEN but no destination has yet accepted.
 *
 *  `deliver()` nulls the pad and removes pad.json the instant it renders, on
 *  the assumption that the destination will take it. Between that instant and
 *  the destination actually accepting, the user's held work exists only as a
 *  local variable — and the entire reason it was held is that they chose not to
 *  risk it. So the PAD is parked here for the duration, and put back if nothing
 *  took it. */
let inFlight: Pad | null = null

/** Is a delivery still waiting on its destination? `inFlight` is set for exactly
 *  as long as one is running: it is assigned before the first `await` and
 *  cleared by commit or restage, and a delivery with nothing to send never
 *  yields at all. So this is an exact answer, not an approximation. */
export function deliveryInFlight(): boolean { return inFlight !== null }

/** Render for this target and clear the pad. Null when there was nothing to
 *  send — the pad is cleared either way, because the user committed it.
 *
 *  IT NEVER CLEARS `inFlight`. Only commit and restage do. Clearing it here on
 *  the nothing-to-send branch is how a second delivery used to destroy a FIRST
 *  delivery's recovery reference: the second call finds the pad already taken,
 *  falls into this branch, and the first pad ends up in no slot at all — and it
 *  is already off disk. Callers must not start a delivery while one is running;
 *  runDelivery is the guard. */
export function takeForDelivery(target: DeliveryTarget): RenderResult | null {
  const taken = pad
  const out = deliver(destinationFor(target))
  if (!out || !out.text.trim()) return null
  inFlight = taken
  return out
}

/** The destination took it. Now the pad is genuinely gone. */
export function commitDelivery(): void { inFlight = null }

/** The destination did NOT take it. Put the work back where the user can reach
 *  it, and back on disk — `deliver()` removed pad.json on an assumption that
 *  turned out to be wrong.
 *
 *  WHERE IT GOES: the live slot, if it is free. That is the normal case, and it
 *  puts the pad straight back in front of the user, armed, ready to retry. If a
 *  new capture has already claimed the live slot, it SETTLES instead — the same
 *  place a pad from a previous run waits, one arm away.
 *
 *  Two pads can want the settled slot at once (a pad from a previous run that
 *  has not been brought back yet). NEITHER IS DELETED: both are on disk by the
 *  time this returns, the more recently touched one is what arming brings back,
 *  and the other's directory is logged. */
export function restageDelivery(): Pad | null {
  const p = inFlight
  inFlight = null
  if (!p) return null
  writePad(p) // durable again before anything else can go wrong
  if (!pad) {
    pad = p
    armed = true
    return p
  }
  const waiting = heldPad
  if (!waiting || p.updatedAt >= waiting.updatedAt) {
    heldPad = p
    if (waiting) console.warn(`[capture] a second pad is waiting on disk: ${padDirFor(scratchpadRoot, waiting.id)}`)
  } else {
    console.warn(`[capture] a second pad is waiting on disk: ${padDirFor(scratchpadRoot, p.id)}`)
  }
  return p
}

/** Where a pad's state lives, so a failure can be logged as a recoverable
 *  location rather than as the user's dictation in a log file. */
export function padDirOf(p: Pad): string { return padDirFor(scratchpadRoot, p.id) }

export interface DeliveryOutcome {
  /** Where it landed — 'cursor', or a task id. Null means nowhere. */
  landed: string | null
  /** The pad, put back, when nothing took it. Null if it landed, or if there
   *  was nothing to send. */
  restaged: Pad | null
  /** What the destination threw, when it threw. */
  error?: unknown
  /** A delivery was already running, so this call did nothing at all. Distinct
   *  from an empty pad, which is also `landed: null` but means the opposite. */
  busy?: boolean
}

/** THE DELIVERY: take the pad, format it for the target, hand it to the
 *  destination — and PUT IT BACK if the destination does not take it.
 *
 *  The destination is injected, not imported. init.ts owns the paste and the
 *  dispatch and neither may be imported into capture/ (nor capture/ into
 *  init.ts) — and injecting it is also what makes the failure path testable,
 *  which is the point: the pad is destroyed BEFORE the destination is reached,
 *  so "what happens when the destination fails" is the question that decides
 *  whether held work can be lost.
 *
 *  `send` returns where it landed, or null for "I did not take it". A throw is
 *  the same answer with a reason attached, and it is a real one: the router's
 *  no-open-tasks branch — the common case, when the user has no tasks — has no
 *  failsafe of its own, so a network blip inside it propagates out. */
export async function runDelivery(
  target: DeliveryTarget,
  send: (text: string) => Promise<string | null>,
  onChanged?: () => void,
): Promise<DeliveryOutcome> {
  // ONE DELIVERY AT A TIME, AND THE SECOND ONE IS IGNORED.
  //
  // A double-click on a Send button is the most ordinary thing a user does, and
  // `inFlight` is a single slot holding the FIRST delivery's only remaining
  // reference to the pad — in memory or on disk. A second call must therefore
  // move no state whatsoever: not the slot, not the pad, not the surface.
  //
  // Ignored rather than queued, deliberately. The pad was taken by the first
  // delivery; a queued second one would have nothing left to send, so queueing
  // would only turn a no-op into a confusing empty delivery.
  if (inFlight) return { landed: null, restaged: null, busy: true }

  const out = takeForDelivery(target)
  // Announce the empty pad straight away: the user committed it, and no surface
  // should sit on stale content through a formatting round-trip.
  announce(onChanged)
  if (!out) return { landed: null, restaged: null }

  const ready = await formatForDelivery(out, target)
  let landed: string | null = null
  let error: unknown
  try {
    landed = await send(ready.text)
  } catch (err) {
    error = err
  }
  if (landed) {
    commitDelivery()
    return { landed, restaged: null }
  }
  const restaged = restageDelivery()
  announce(onChanged)
  return { landed: null, restaged, error }
}

/** Tell the surfaces, and never let that be the thing that goes wrong.
 *
 *  This runs BETWEEN taking the pad and releasing `inFlight`. A throw here
 *  would leave the slot occupied forever and wedge every later delivery as
 *  "busy" — with the pad it is holding unreachable. A surface failing to
 *  repaint is not a reason to lose the user's work. */
function announce(onChanged?: () => void): void {
  try {
    onChanged?.()
  } catch (err) {
    console.warn('[capture] scratchpad broadcast failed:', err)
  }
}

/** FORMATTING HAPPENS HERE, AND ONLY FOR THE CURSOR.
 *
 *  The pad holds the CLEANED transcript; the destination is not known until the
 *  user picks one, so the polish that belongs to a destination is applied at
 *  the end rather than at capture time. Formatted once, where the destination
 *  is finally known.
 *
 *  A TASK GETS THE TEXT AS-IS. An agent does not need punctuation polish, and
 *  running an instruction through the formatter costs latency and risks the
 *  model rewriting what the user actually asked for. So the registered
 *  formatter is not called at all for a task target — not called and its result
 *  ignored, but never invoked.
 *
 *  Every failure returns the text unchanged: held work has already been cleared
 *  from the pad by this point, so losing it to a formatter is not an option. */
export async function formatForDelivery(
  out: RenderResult,
  target: DeliveryTarget,
): Promise<RenderResult> {
  if (destinationFor(target) !== 'cursor' || !formatFn) return out
  try {
    const text = await formatFn(out.text)
    return typeof text === 'string' && text.trim() ? { ...out, text } : out
  } catch (err) {
    console.warn('[capture] delivery formatting failed — sending as captured:', err)
    return out
  }
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
  if (pad) writePad(pad)
}

/** Atomic write of ANY pad, not only the live one — restaging a failed delivery
 *  has to put a pad back on disk that is no longer in the live slot. */
function writePad(p: Pad): void {
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
 *  `pad !== null`) is what keeps a sequence resume from arming a watcher the
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

// ── Our own pasteboard sequences ────────────────────────────────────────
//
// THE RACE THIS CLOSES. captureSelectedText clears the pasteboard, has ANOTHER
// PROCESS copy into it, then restores it — three changes, all ours, all inside
// a hot-mic window. Each announces itself through noteOwnClipboardWrite(), but
// the middle one is performed asynchronously by osascript, so the announcement
// cannot happen until the child's callback runs. Traced timeline:
//
//   T+0    we clear, and record it
//   T+200  the target app serves our synthesised ⌘C — counter moves
//   T+250  the 250ms poll ticks, sees a counter it was never told about, and
//          inserts THE USER'S OWN SELECTION
//   T+260  execFile's callback finally lets us record that counter — too late
//
// And the damage is not confined to the pad: that insert also pushes
// capture:insert-detected, which sets insertPendingRef, which permits an
// earlier chunk boundary — so it MOVES THE UNARMED FAST PATH'S CHUNKING.
//
// Re-baselining after the fact cannot fix this: a tick that already fired
// cannot be retracted. So observation is suspended for the DURATION of the
// sequence instead, by construction:
//
//   * stop()   — the interval is cleared, so no tick can START inside it.
//   * disarm() — armed=false, so a tick suspended mid-await on rescueImage
//                takes the module's own "the window closed" exit and delivers
//                nothing.
//   * a detection-time floor — on resume, any insert whose DETECTION instant
//                is at or before the end of the sequence is refused. This is
//                what catches the one remaining case: a rescue that was
//                already in flight when suppression began and only resolves
//                after it ends. Causal, not timing-based — we are refusing
//                what was seen during a window we know was ours.
//
// The cost is that a genuine copy is not captured for as long as the sequence
// runs. THAT IS NOT A FIXED ~350ms, and it would be dishonest to write it as
// one: simulateViaOsascript and the key-poster path call execFile with NO
// timeout, so if System Events blocks — an unresponsive target app, an
// Accessibility prompt — captureSelectedText runs as long as its child does,
// and suppression runs with it. Typical is a few hundred milliseconds;
// worst case is unbounded.
//
// We do NOT fix that by putting a timeout on the child: that is pre-existing
// behaviour on the dictation fast path, and cutting off a slow-but-working app
// is a worse risk than the one it would solve. We bound the SUPPRESSION
// instead. Suppression exists to exclude a sub-second sequence; if it is still
// up an order of magnitude later, something has gone wrong and the right
// failure is "capture resumes", not "capture is dead for this recording".

let ownSequenceDepth = 0
/** No insert may be admitted whose DETECTION instant is at or before this. */
let suppressDetectedUpTo = 0
let ownSequenceTimer: ReturnType<typeof setTimeout> | null = null

/** Generous multiple of a healthy sequence (~350ms), short enough that a hung
 *  child cannot cost the user a whole recording's captures. */
export const OWN_SEQUENCE_MAX_MS = 3000
let ownSequenceCeilingMs = OWN_SEQUENCE_MAX_MS

/** Test-only: shorten the ceiling so its expiry is observable. */
export function setOwnSequenceCeiling(ms: number): void { ownSequenceCeilingMs = ms }

/** Unmute is about to perform a multi-step pasteboard sequence of its own.
 *  Re-entrant: nested/overlapping sequences suspend once and resume once. */
export function beginOwnClipboardSequence(): void {
  ownSequenceDepth++
  if (ownSequenceDepth > 1) return
  try {
    clipboardWatch?.stop()
    clipboardWatch?.disarm()
  } catch (err) {
    console.warn('[capture] clipboard suspend failed:', err)
  }
  clearOwnSequenceTimer()
  ownSequenceTimer = setTimeout(() => {
    ownSequenceTimer = null
    if (ownSequenceDepth === 0) return
    // The caller never came back. Do not wait on it — a hung osascript would
    // otherwise hold capture down for the rest of the recording, and refuse
    // unrelated screenshot inserts along the way.
    console.warn('[capture] own-clipboard sequence exceeded its ceiling — resuming observation')
    ownSequenceDepth = 0
    resumeAfterOwnSequence(Date.now())
  }, ownSequenceCeilingMs)
  ;(ownSequenceTimer as unknown as { unref?: () => void }).unref?.()
}

/** The sequence is finished and the pasteboard is back to the user's. */
export function endOwnClipboardSequence(now: number): void {
  if (ownSequenceDepth === 0) return
  ownSequenceDepth--
  if (ownSequenceDepth > 0) return
  clearOwnSequenceTimer()
  resumeAfterOwnSequence(now)
}

function clearOwnSequenceTimer(): void {
  if (ownSequenceTimer) { clearTimeout(ownSequenceTimer); ownSequenceTimer = null }
}

function resumeAfterOwnSequence(now: number): void {
  if (now > suppressDetectedUpTo) suppressDetectedUpTo = now
  if (!watchersArmed || !pad) return
  // SEPARATE try BLOCKS, deliberately. Sharing one means a throwing arm()
  // skips start(), leaving the watcher stopped AND disarmed for the rest of
  // the recording — logged, never recovered. Losing the baseline is bad;
  // losing the baseline AND the polling is strictly worse, and the pre-fix
  // shape failed safer here.
  try {
    // arm() re-baselines to the counter as it stands NOW, so every change the
    // sequence made is, by construction, not a candidate.
    clipboardWatch?.arm(padDirFor(scratchpadRoot, pad.id))
  } catch (err) {
    console.warn('[capture] clipboard re-baseline failed:', err)
  }
  try {
    clipboardWatch?.start()
  } catch (err) {
    console.warn('[capture] clipboard resume failed:', err)
  }
}

/** Full reset — tests only. */
export function _resetForTest(): void {
  disarmWatchers()
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
  pad = null
  heldPad = null
  inFlight = null
  armed = false
  openSegmentId = null
  captureStartedAt = 0
  pasteFn = null
  formatFn = null
  settingsFn = null
  clipboardWatch = null
  screenshotWatch = null
  watchersArmed = false
  clearOwnSequenceTimer()
  ownSequenceDepth = 0
  suppressDetectedUpTo = 0
  ownSequenceCeilingMs = OWN_SEQUENCE_MAX_MS
  sharedLedger.ownWrites.clear()
  sharedLedger.claims.clear()
  scratchpadRoot = SCRATCHPAD_ROOT
}
