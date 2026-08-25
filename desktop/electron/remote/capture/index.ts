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
import type { Destination, Entry, InsertKind, Pad, Segment } from './types'
import { deserialize, padDirFor, serialize, shouldSettle } from './scratchpadStore'
import { createClipboardWatch } from './clipboardWatch'
import { createScreenshotWatch } from './screenshotWatch'
import {
  addInsert, addSegment, emptyPad, isEmpty, removeEntry, setSegmentEnd, setSegmentText,
} from './captureBuffer'
import { splitSpeech } from './speechSplit'
import { render, type RenderResult } from './insertRender'
import { canArmScratchpad, type CaptureSettings } from './captureGate'
import { TEXT_DEDUP_WINDOW_MS, claimContent, createClaims } from './clipboardLedger'

/** Where pads live on disk. Unmute-owned, safe to delete, recreated on demand. */
export const SCRATCHPAD_ROOT = join(homedir(), '.unmute', 'remote', 'scratchpad')

/** Overridable so tests never touch the user's real scratchpad. */
let scratchpadRoot = SCRATCHPAD_ROOT
export function setScratchpadRoot(root: string): void { scratchpadRoot = root }

let pad: Pad | null = null
let armed = false
let openSegmentId: string | null = null

/** A pad a PREVIOUS RUN left on disk, deserialized at startup and waiting.
 *
 *  It is deliberately NOT the live pad. A settled pad must survive every
 *  ordinary dictation that happens before the user comes back to it, and the
 *  live slot cannot give it that: beginSegment drops an unarmed pad at each
 *  capture boundary, and it would append the next unarmed utterance to it
 *  besides. So held work waits HERE, out of the capture path entirely, and
 *  arming promotes it back — see armScratchpad. */
let heldPad: Pad | null = null

// Both detectors claim against ONE dedup map, because a tool set to write a
// file AND copy fires each of them for a single user action. It lives HERE, not
// in init.ts, because recordInsert is the one point the two detectors converge.
//
// CLAIMS ONLY — deliberately not a whole Ledger. The own-write skip set is the
// clipboard watcher's, written and read entirely inside it; a Ledger here would
// carry an `ownWrites` set nothing could ever write, which reads as a second
// skip set that silently skips nothing.
const sharedClaims = createClaims()

/** The screenshot watcher's path-keyed claim. Exposed so init.ts can hand it to
 *  createScreenshotWatch without owning a second dedup map.
 *
 *  `windowMs` lets the TEXT claim below ask the same map a tighter question —
 *  the two races have different timescales. Defaulted, so the screenshot
 *  watcher's call site is unchanged. */
export function claimShared(hash: string, atMs: number, windowMs?: number, detector?: string): boolean {
  return claimContent(sharedClaims, hash, atMs, windowMs, detector)
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

/** `images` are absolute paths, delivered AFTER the text and in order. A plain
 *  text field cannot hold an image, so the pasteboard hands the real bytes over
 *  — see clipboard.ts's injectOutput for how that is sequenced without racing
 *  the text's own ⌘V. */
type PasteFn = (text: string, images?: readonly string[]) => Promise<void>
let pasteFn: PasteFn | null = null

export function registerPaste(fn: PasteFn): void { pasteFn = fn }

export async function pasteAtCursor(text: string, images?: readonly string[]): Promise<boolean> {
  if (!pasteFn) return false
  await pasteFn(text, images)
  return true
}

/**
 * A KEYSTROKE IS THE WRONG INSTRUMENT FOR A DESTINATION UNMUTE OWNS.
 *
 * Dictating into a task's composer put the text in and lost the image. The
 * timeline: the text ⌘V landed at t+8ms and the composer took it; 492ms later
 * the image sequencer posted a SECOND synthetic ⌘V that never reached the notch
 * at all — no paste decision logged, nothing staged — while the sequencer still
 * reported "pasted 1/1", because all it knows is that it posted a key, not that
 * anything accepted it.
 *
 * When the focused text box is Unmute's own, the images can simply be handed to
 * it. Returns true when the composer took them, and the caller then skips the
 * keystrokes entirely; false means no composer is focused and the ordinary
 * cursor paste is still correct.
 *
 * Registered rather than imported, the same inversion as the paste effect —
 * clipboard.ts must not import init.ts.
 */
type ComposerImageSink = (paths: readonly string[]) => boolean
let composerImageSink: ComposerImageSink | null = null

export function registerComposerImageSink(fn: ComposerImageSink | null): void {
  composerImageSink = fn
}

export function stageImagesIntoFocusedComposer(paths: readonly string[]): boolean {
  if (!composerImageSink || !paths.length) return false
  try { return composerImageSink(paths) } catch { return false }
}

/** History copy is staged by clipboard.ts for the next user-initiated Cmd+V.
 * Registered here for the same acyclic dependency-inversion reason as pasteFn. */
type HistoryCopyFn = (text: string, images: readonly string[]) => void
let historyCopyFn: HistoryCopyFn | null = null

export function registerHistoryCopy(fn: HistoryCopyFn): void { historyCopyFn = fn }

export function copyHistoryToClipboard(text: string, images: readonly string[]): boolean {
  if (!historyCopyFn) return false
  historyCopyFn(text, images)
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

/** THE PAD CHANGED WITHOUT ANYONE ASKING IT TO.
 *
 *  Three of the pad's mutations come from the capture lifecycle rather than
 *  from a user gesture on a surface — a capture ending, a transcript landing
 *  30-45s later, an open segment being cancelled — and before this there was
 *  nothing to announce them. The visible cost was the whole feature: an armed
 *  stop settles the pad and the panel is supposed to appear holding it, but the
 *  last broadcast happened at the last COPY, so the panel showed a pad with an
 *  empty segment in it and the user's words never arrived on screen.
 *
 *  Registered rather than imported, the same inversion as the paste and format
 *  effects and for the same reason: capture/ must not import init.ts.
 *
 *  NOT called from beginSegment. Capture start is the hottest point on the
 *  path, and there is nothing to say there anyway — an unarmed pad is not shown
 *  and an armed one has not changed yet. */
type PadObserverFn = () => void
let padObserver: PadObserverFn | null = null

export function registerPadObserver(fn: PadObserverFn): void { padObserver = fn }

/** Tell the surfaces, and never let that be the thing that goes wrong. A
 *  surface failing to repaint must not abort a capture lifecycle step. */
function announcePad(): void {
  try { padObserver?.() } catch (err) { console.warn('[capture] pad announce failed:', err) }
}

export function getCaptureSettings(): CaptureSettings {
  try {
    return settingsFn?.() ?? { scratchpadEnabled: true, captureEnabled: true }
  } catch {
    return { scratchpadEnabled: true, captureEnabled: true }
  }
}

export function isArmed(): boolean { return armed }

/** Is a capture RUNNING right now — mic hot, segment open?
 *
 *  Delivery asks, because a pad with an open segment is not held work however
 *  it got here: it is the buffer of an utterance still being spoken, and
 *  sending it would deliver half a sentence and leave every later
 *  attachTranscript writing into a pad that has been taken away. */
export function segmentOpen(): boolean { return openSegmentId !== null }

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

/** WHICH PAD IS THE USER'S HELD WORK — the only pad a surface may show, offer
 *  destinations for, or discard.
 *
 *  IT IS NOT `pad`. `beginSegment` opens a live pad for EVERY dictation, armed
 *  or not, because inserts have to be positioned against speech either way. An
 *  unarmed one is scaffolding: nothing consumes it (delivery goes down the
 *  ordinary dictation path) and the next capture boundary throws it away. It is
 *  not something the user asked to keep, and a surface must never present it as
 *  such — offering "send this somewhere" for an utterance that is about to be
 *  pasted automatically is confusing, and offering "discard" for it is
 *  destructive: the user is still speaking into it.
 *
 *  So: the live pad ONLY while armed, and otherwise whatever settled and is
 *  waiting. `?? held` rather than a plain ternary is deliberate belt-and-braces
 *  — arming promotes a settled pad into the live slot, so armed-with-no-pad
 *  should be unreachable, and if it ever happens the held pad is still the
 *  honest answer.
 *
 *  NOTHING DELIVERABLE IS NOTHING TO SHOW. A pad whose only entry is the blank
 *  segment of an armed tap that said nothing has entries but no content, and
 *  every destination button on it would render ''. See captureBuffer.isEmpty:
 *  the same rule decides what can be delivered and what can be drawn, because
 *  they are the same question.
 *
 *  SETTLE, DO NOT NAG (§9). A pad that has been idle past the threshold stops
 *  ASKING for attention while keeping everything it holds: it is still on disk,
 *  still exactly where it was, and arming brings it straight back
 *  (armScratchpad promotes `held` with no settle check of its own). Without
 *  this, a pad adopted at startup put a 380×460 always-on-top panel on the
 *  screen at EVERY launch until it was dealt with — the nagging product §9
 *  exists to prevent. The rule applies only to a SETTLED pad: a live armed one
 *  is the capture the user is in the middle of, whatever its timestamps say. */
export function heldForSurface(
  s: ScratchpadSnapshot = snapshot(),
  now: number = Date.now(),
): Pad | null {
  const live = s.armed ? s.pad : null
  if (live) return isEmpty(live) ? null : live
  const held = s.held
  if (!held || isEmpty(held) || shouldSettle(held, now)) return null
  return held
}

/** Bring a settled pad back into the live slot.
 *
 *  THE DELIVERY SEAM ONLY EVER READS THE LIVE SLOT (`deliver()` renders `pad`
 *  and nothing else), so a settled pad cannot be delivered from where it
 *  waits — every destination button on one would be inert. This is the same
 *  move `armScratchpad` makes, minus the arming: a delivery is about to empty
 *  the slot again, so marking it held in between would be a lie.
 *
 *  DELIBERATELY NOT GATED on canArmScratchpad. The gate exists to stop NEW work
 *  being held when the feature is off; work that is ALREADY held must stay
 *  deliverable, or turning the setting off would strand it on disk with no way
 *  to get it out.
 *
 *  False when the live slot is taken — a capture is in progress, and its pad is
 *  somebody else's. Callers must handle that rather than delivering the wrong
 *  pad. */
export function promoteSettledPad(): boolean {
  if (pad || !heldPad) return false
  pad = heldPad
  heldPad = null
  return true
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
 *  DISARMING SETTLES WHAT IS ALREADY HELD; it does not abandon it. In-session
 *  held work does NOT live in `heldPad` — after an armed stop it sits in `pad`
 *  with `armed = true`, and `heldPad` is written only by adoptPersistedPad and
 *  by a restage into an occupied slot. So merely clearing the flag left that
 *  pad live-but-unarmed: heldForSurface stopped returning it, the panel
 *  emptied, and the files were destroyed at the next beginSegment or the next
 *  arm's dropLivePad. That is silent loss of work the user explicitly chose to
 *  keep, which is the one failure this feature exists to prevent. Moving it to
 *  the settled slot keeps it on screen, deliverable (promoteSettledPad is not
 *  behind the gate), discardable, and one arm away from being live again.
 *
 *  NOT mid-capture. Settling a pad the recorder is still writing into would
 *  null the live slot under it, and every later attachTranscript and
 *  recordInsert returns early on a null pad. Disarming during a capture keeps
 *  its existing meaning: the pad stays live and unarmed and is delivered the
 *  ordinary way at stop.
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
  if (!next && armed && pad && !openSegmentId && !isEmpty(pad)) {
    const p = pad
    pad = null
    writePad(p)     // durable before anything else can go wrong
    settlePad(p)
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
  // AN ARMED PAD FOLLOWS THE LANE THAT IS FILLING IT NOW.
  //
  // A pad survives across captures, and its origin decides which destinations
  // the panel offers — an 'agent' pad offers the Agent alone. The origin used
  // to be set only when a pad was CREATED, so held work kept the address of
  // whichever capture happened to open it: pause a dictation, resume it with
  // right-Option, and the panel still offered you the cursor for work that is
  // now addressed at a task. Resuming in another lane IS a switch, just one
  // taken across a pause instead of during a capture, so it moves the origin
  // for the same reason a mid-capture switch does.
  else if (pad.origin !== origin) pad = { ...pad, origin, updatedAt: now }
  openSegmentId = randomUUID()
  clearOwnSequenceTimer()
  ownSequenceDepth = 0
  suppressDetectedUpTo = 0
  // PAD-RELATIVE, not capture-relative — see types.ts. A fresh pad was created
  // with createdAt === now, so an unarmed capture still stamps 0 and the fast
  // path is unmoved; an ARMED pad carried over from an earlier capture stamps
  // the real offset, which is the whole point.
  pad = addSegment(pad, { id: openSegmentId, text: '', startMs: now - pad.createdAt, endMs: 0, now })
  armWatchers(padDirFor(scratchpadRoot, pad.id), observe)
  schedulePersist()
  return openSegmentId
}

/**
 * The live capture changed lanes — move the pad's address with it.
 *
 * NARROW ON PURPOSE, AND THE ALTERNATIVE IS A DISASTER. The obvious way to
 * restamp the origin mid-capture is to call beginSegment again with the new
 * one. It would do three things, all of them wrong here: discard an unarmed
 * pad and allocate a fresh one, losing every insert recorded so far; mint a
 * second openSegmentId, so the transcript lands in a new empty segment and
 * orphans the real one; and reset ownSequenceDepth/suppressDetectedUpTo to
 * zero. That last is the quiet one — with an own-clipboard sequence in flight
 * (the selection grab shells out to osascript for ~200ms), the matching
 * endOwnClipboardSequence then returns early at depth 0, resumeAfterOwnSequence
 * never runs, and the clipboard watcher stays stopped and disarmed for the rest
 * of the recording. Every copy and screenshot after that point is silently
 * dropped.
 *
 * So this writes one field and announces. Nothing else.
 */
export function setPadOrigin(origin: Destination, now: number): void {
  if (!pad || pad.origin === origin) return
  pad = { ...pad, origin, updatedAt: now }
  schedulePersist()
  announcePad()
}

export function endSegment(now: number): void {
  disarmWatchers()
  const closing = openSegmentId
  openSegmentId = null
  // The claims map is per-capture: it exists to merge two detectors reporting
  // ONE user action within a 2s window, and that question dies with the
  // window. Without this it is a Map that only ever grows, for the lifetime of
  // the main process.
  sharedClaims.claims.clear()
  if (pad) {
    // The stretch is over, so its end is known — on the pad's clock, so a
    // surface can show a duration (`endMs - startMs`) for a segment from ANY
    // capture in the pad. It was written as a literal 0 and never touched
    // again, which made every segment's duration unknowable.
    //
    // updatedAt is bumped FIRST and unconditionally: setSegmentEnd is a silent
    // no-op on a segment that is already gone (Escape), and the pad was
    // touched by this capture either way.
    const endedAt = now - pad.createdAt
    pad = { ...pad, updatedAt: now }
    if (closing) pad = setSegmentEnd(pad, closing, endedAt, now)
    schedulePersist()
  }
  // An ARMED stop settles the pad instead of delivering it — this is the moment
  // the panel is supposed to appear holding it.
  announcePad()
}

/** FILL A SEGMENT IN — AND OPEN A SEAM IN IT WHEREVER SOMETHING WAS CAPTURED.
 *
 *  One capture opens one segment and the transcript arrives as one string, so
 *  before this the buffer had no position inside the speech for an insert to
 *  occupy: everything copied sorted after every word, and a link copied
 *  mid-sentence came out at the end of the paste. `splitSpeech` decides where
 *  the seams go (sentence boundaries only, never mid-word — see its header for
 *  why the seam is made here rather than in the audio).
 *
 *  ONE PIECE IS THE OLD BEHAVIOUR, EXACTLY. `splitSpeech` returns a single
 *  piece whenever it cannot do better — nothing captured inside the stretch, no
 *  sentence boundary, no measurable duration — and this then takes the plain
 *  `setSegmentText` path with the text UNCHANGED. The overwhelmingly common
 *  dictation therefore produces the same pad it always did.
 *
 *  PIECE IDS ARE DERIVED, NOT RANDOM (`<segment>#1`, `#2`, …), so a pad written
 *  to disk and read back holds the same ids it held in memory, and a surface
 *  removing a row removes the same row after a restart. Piece 0 keeps the
 *  original id: it is still the segment the capture opened. */
function withSplitSegment(p: Pad, segmentId: string, text: string, now?: number): Pad {
  const seg = p.entries.find((e) => e.type === 'segment' && e.id === segmentId) as Segment | undefined
  if (!seg) return p
  const times = p.entries.filter((e) => e.type === 'insert').map((e) => e.atMs)
  const pieces = splitSpeech(text, seg.startMs, seg.endMs, times)
  if (pieces.length === 1) return setSegmentText(p, segmentId, text, now)
  const replacement: Entry[] = pieces
    // A BLANK SEGMENT IS NEVER WRITTEN TO A PAD. sentenceBoundaries already
    // refuses a cut past the last non-space character, so this cannot trigger
    // today — it is here because "no piece is blank" is a promise made by
    // another module, and a pad row that renders nothing is exactly the kind of
    // thing that pins a panel open on "Still transcribing…" forever. Cheap
    // enough to enforce where the entries are actually built.
    .filter((pc) => pc.text.trim() !== '')
    .map((pc, i) => ({
      type: 'segment',
      id: i === 0 ? seg.id : `${seg.id}#${i}`,
      text: pc.text.trim(),
      startMs: pc.startMs,
      endMs: pc.endMs,
    }))
  if (!replacement.length) return setSegmentText(p, segmentId, text, now)
  const entries = p.entries.flatMap((e) =>
    (e.type === 'segment' && e.id === segmentId) ? replacement : [e])
  return { ...p, entries, updatedAt: now ?? p.updatedAt }
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
    ? withSplitSegment(pad, segmentId as string, text, now)
    // The segment this text belonged to is gone, so its real start is gone
    // with it. `now` is the closest honest stamp there is — it puts the
    // recovered speech at the END of the pad, which for a multi-capture pad is
    // far nearer the truth than the literal 0 that used to be written here
    // (that put re-processed audio in front of everything said before it).
    : addSegment(pad, { id: randomUUID(), text, startMs: now - pad.createdAt, endMs: now - pad.createdAt, now })
  schedulePersist()
  // The words arrive 30-45s after the audio. Without this the panel would sit
  // on "Still transcribing…" forever — the pad's whole content, never shown.
  announcePad()
}

/** An insert arrived from either watcher. Position is relative to the PAD's
 *  creation, so it sorts against every segment and every other insert in the
 *  pad on one clock — including ones from earlier captures. See types.ts for
 *  why a per-capture origin does not compose.
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
 *  path here is a decision that this insert does not exist, so anything the
 *  caller does about an insert — announcing it to a surface, above all — has to
 *  be gated on the answer, or the pad and the screen disagree about what
 *  happened. */
export function recordInsert(
  i: { kind: InsertKind; content: string; atMs: number; detector?: string },
  now: number,
): boolean {
  if (!pad) { insertDecision('rejected', i, 'no-pad'); return false }
  // Anything SEEN while Unmute owned the pasteboard is Unmute's, not the
  // user's — see beginOwnClipboardSequence. Checked on the detection instant,
  // not on arrival, so a rescue that outlives the sequence is refused too.
  // screenshotWatch is NOT suspended and fires synchronously, so this is a
  // reachable path, not a theoretical one.
  //
  // BOTH SIDES ARE WALL-CLOCK HERE, and must stay that way: `i.atMs` is what a
  // watcher's `now()` returned and `suppressDetectedUpTo` is a `Date.now()`.
  // The conversion to the pad's clock happens strictly BELOW this comparison —
  // moving it above would silently change the units under the floor.
  if (ownSequenceDepth > 0 || i.atMs <= suppressDetectedUpTo) {
    insertDecision('rejected', i, ownSequenceDepth > 0 ? 'own-clipboard-sequence' : 'suppressed-window')
    return false
  }
  if (i.kind === 'image') {
    const sig = imageSignature(i.content)
    // An unreadable file yields no signature. Insert it rather than dropping
    // it — a missed dedup shows the user one extra thumbnail they can remove,
    // while a wrong drop loses something they captured on purpose.
    if (sig && !claimShared(sig, i.atMs, undefined, i.detector)) {
      insertDecision('rejected', i, 'duplicate-of-same-action')
      return false
    }
  } else if (!claimShared(`text:${i.content}`, i.atMs, TEXT_DEDUP_WINDOW_MS, i.detector)) {
    // ONE COPY IS ONE INSERT — even when the pasteboard was written three
    // times. A browser writes several flavours for a single ⌘C (plain text,
    // HTML, a public.url), and EACH write bumps changeCount, so the watcher
    // sees N transitions with identical text and the user got the same link
    // two or three times in one paste. Observed in the field.
    //
    // Claimed on the CONTENT, not the kind: the same string can classify
    // differently between ticks (a path that exists on one read and not the
    // next), and one user action is one insert whatever the classifier said.
    // The `text:` prefix keeps a transcript that happens to look like an image
    // signature ("1024:d41d8…") from colliding with one.
    //
    // ITS OWN WINDOW, NOT THE IMAGE ONE. The multi-flavour burst is sub-100ms;
    // the 2s image window exists for a screenshot tool's disk write racing its
    // pasteboard write. Borrowing it swallowed a deliberate second ⌘C of the
    // same string a second later — an ordinary thing to do. See
    // TEXT_DEDUP_WINDOW_MS.
    return false
  }
  pad = addInsert(pad, {
    id: randomUUID(), kind: i.kind, content: i.content,
    atMs: i.atMs - pad.createdAt, now,
  })
  insertDecision('accepted', i, null, pad.entries.filter((e) => e.type === 'insert').length)
  schedulePersist()
  return true
}

/**
 * EVERY INSERT DECISION IS VISIBLE.
 *
 * This path recorded nothing, so when a user reported captured images going
 * missing there was no way to tell whether a detector never saw them or saw
 * them and refused them — the difference between two completely different
 * bugs. A capture that does not arrive must at least say why it did not.
 */
function insertDecision(
  outcome: 'accepted' | 'rejected',
  i: { kind: InsertKind; content: string; atMs: number; detector?: string },
  reason: string | null,
  padInserts?: number,
): void {
  try {
    console.log('[capture] insert', JSON.stringify({
      outcome, reason, kind: i.kind, detector: i.detector ?? null,
      // The content is a path for an image and the user's own words for text;
      // only its shape is diagnostic, so text is never echoed to the log.
      content: i.kind === 'image' ? i.content : `${i.content.length} chars`,
      atMs: i.atMs, padInserts: padInserts ?? null,
    }))
  } catch { /* diagnostics never alter capture */ }
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
  // A removal can come from the capture lifecycle and not from a surface — the
  // empty segment of an armed tap that said nothing is dropped when the
  // transcript comes back blank, long after the panel last drew — so it
  // announces itself, exactly like attachTranscript. (A surface that removes an
  // entry re-broadcasts too; the push is idempotent, as it is for discard.)
  announcePad()
}

/** Render and clear. Returns null when there is nothing to send.
 *
 *  IT DOES NOT TOUCH THE DISK. pad.json is the ONLY remaining copy of the work
 *  between here and the destination accepting it, and that gap is not short: a
 *  task send drives another app and has been measured at ~36s. Removing the
 *  file here meant a crash or a quit inside that window lost the pad from
 *  memory AND from disk, which is precisely the failure the scratchpad exists
 *  to prevent. commitDelivery removes it, once the destination has actually
 *  taken it; takeForDelivery removes it when there was nothing to send. */
export function deliver(dest: Destination): RenderResult | null {
  const p = pad
  if (!p || isEmpty(p)) { pad = null; armed = false; return null }
  const out = render(p, dest)
  pad = null
  armed = false
  return out
}

/** The user threw the pad away. Unlike deliver, this takes the files too —
 *  INCLUDING a settled pad's, because from the user's side there is only ever
 *  one pad: if nothing is live, the pad they mean is the one waiting to come
 *  back. Leaving it on disk would resurrect it at the next arm.
 *
 *  IT WILL NOT TOUCH AN UNARMED CAPTURE IN PROGRESS. That pad is not held work
 *  — it is the buffer for an ordinary dictation the user is still speaking into
 *  (see heldForSurface), and no surface offering Discard is showing it. Dropping
 *  it would clear `openSegmentId` and silently destroy that utterance: every
 *  later `attachTranscript` and `recordInsert` returns early on a null pad, so
 *  the words and anything copied after would go nowhere, with nothing on screen
 *  to say so. This is the guard `armScratchpad` already applies for the same
 *  reason, in the same words: never drop a pad with an open segment out from
 *  under the capture that owns it. */
export function discard(): void {
  if (armed || !openSegmentId) dropLivePad()
  const h = heldPad
  heldPad = null
  if (h) discardPadFiles(h)
  announcePad()
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
/** Where a held pad can be sent. 'agent' hands it to the Unmute Agent, which
 *  is the only destination an Agent-addressed pad offers. */
export type DeliveryTarget = 'cursor' | 'newTask' | 'openTask' | 'agent'

/** Whether a delivery may proceed, and if not, why. */
export type DeliveryGate = 'ok' | 'capture-in-progress' | 'nothing-showing' | 'live-slot-taken'

/** MAY A DELIVERY TAKE THE PAD RIGHT NOW — decided here, where it is testable,
 *  rather than in the untestable handler that used to own it.
 *
 *  Three refusals, and the middle one is why this moved. The rule the surface
 *  was drawn from is `heldForSurface`, and it returns NULL for a pad that has
 *  settled past the idle threshold — so once a pad settles, `showing` is null,
 *  the `showing && …` guard is skipped entirely, and delivery proceeds against
 *  whatever is in the LIVE slot. That could be a finished unarmed dictation's
 *  leftover buffer: a different dictation from the one the user meant, sent
 *  with no confirmation. Not reachable through the panel today (it hides at the
 *  same instant the pad settles) but this is a registered handler, and "the
 *  surface happens not to call it" is not a guarantee.
 *
 *  NOTHING SHOWING IS NOTHING TO SEND. It is the same rule the panel is drawn
 *  from, asked the same way, so a delivery can only ever move a pad the user
 *  was actually looking at.
 *
 *  It PROMOTES on the way through when the pad on screen is a settled one: the
 *  delivery seam only ever reads the live slot, so without that every
 *  destination button on a settled pad would be inert. */
export function gateDelivery(now: number = Date.now()): DeliveryGate {
  // Asked directly rather than inferred from `showing !== pad`: an ARMED pad
  // delivered mid-capture has `showing === pad`, so an identity test lets it
  // through — nulling the live slot with `openSegmentId` still set and leaving
  // every later attachTranscript and recordInsert writing into nothing.
  if (segmentOpen()) return 'capture-in-progress'
  const before = snapshot()
  const showing = heldForSurface(before, now)
  if (!showing) return 'nothing-showing'
  // The live slot is taken by a pad that is not the one on screen. Refusing is
  // the only honest answer: delivering the live pad would send somebody else's
  // utterance. The pad on screen is untouched on disk.
  if (showing !== before.pad && !promoteSettledPad()) return 'live-slot-taken'
  return 'ok'
}

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
  if (!out || !out.text.trim()) {
    // Nothing is going anywhere, so nothing is at risk: there is no destination
    // to wait for and no restage to come. The state file goes now rather than
    // outliving the pad it describes and being adopted at the next launch.
    if (taken) removePadState(taken)
    return null
  }
  inFlight = taken
  return out
}

/** The destination took it. NOW the pad is genuinely gone — and only now is
 *  pad.json removed, because until this point it was the one durable copy of
 *  work the user chose not to risk (see deliver). */
export function commitDelivery(): void {
  const p = inFlight
  inFlight = null
  // The rescued FILES stay, because a delivered pad's attachments are
  // referenced by whatever received them. Only the state file goes.
  if (p) removePadState(p)
}

/** The destination did NOT take it. Put the work back where the user can reach
 *  it, and re-assert it on disk. pad.json has been there all along now that
 *  only commitDelivery removes it, so this write is belt-and-braces rather than
 *  a recovery — and it stays, because the pad's `updatedAt` decides which of
 *  two settled pads arming brings back, and because a pad that was never
 *  persisted in the first place (a write that failed earlier) gets its chance
 *  here.
 *
 *  WHERE IT GOES: the live slot, if it is free. That is the normal case, and it
 *  puts the pad straight back in front of the user, armed, ready to retry. If a
 *  new capture has already claimed the live slot, it SETTLES instead — the same
 *  place a pad from a previous run waits, one arm away.
 *
 *  Two pads can want the settled slot at once (a pad from a previous run that
 *  has not been brought back yet) — settlePad owns that rule, and a disarm
 *  reaches it too. Nothing is deleted either way. */
export function restageDelivery(now: number = Date.now()): Pad | null {
  const taken = inFlight
  inFlight = null
  if (!taken) return null
  // TOUCHED, because the user just touched it. `updatedAt` is what the settle
  // rule measures idleness against, and a restage that left it alone made a pad
  // idle past the threshold vanish from the screen at the exact moment the user
  // pressed Send on it — the one moment they are demonstrably engaged with it.
  // It is also the tie-break between two settled pads, and the one somebody
  // just tried to send should be the one arming brings back.
  const p = { ...taken, updatedAt: now }
  writePad(p) // durable again before anything else can go wrong
  if (!pad) {
    pad = p
    armed = true
    return p
  }
  settlePad(p)
  return p
}

/** Park a pad in the SETTLED slot, where arming brings it back from.
 *
 *  Two pads can want that slot at once — a restage or a disarm meeting a pad
 *  from a previous run that has not been brought back yet. NEITHER IS DELETED:
 *  both are on disk by the time this returns, the more recently touched one is
 *  what arming brings back, and the other's directory is logged so it can be
 *  recovered by hand.
 *
 *  Callers persist first (see writePad) — this only decides the slot. */
function settlePad(p: Pad): void {
  const waiting = heldPad
  if (!waiting || p.updatedAt >= waiting.updatedAt) {
    heldPad = p
    if (waiting) console.warn(`[capture] a second pad is waiting on disk: ${padDirFor(scratchpadRoot, waiting.id)}`)
  } else {
    console.warn(`[capture] a second pad is waiting on disk: ${padDirFor(scratchpadRoot, p.id)}`)
  }
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
  /** Immutable delivery snapshot. Present only after the destination accepted
   *  the pad, so callers can archive it without racing the live buffer. */
  delivered?: { pad: Pad; text: string; attachments: string[] }
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
  send: (text: string, attachments: readonly string[]) => Promise<string | null>,
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
    landed = await send(ready.text, ready.attachments)
  } catch (err) {
    error = err
  }
  if (landed) {
    const delivered = inFlight
    commitDelivery()
    return delivered
      ? { landed, restaged: null, delivered: { pad: delivered, text: ready.text, attachments: [...ready.attachments] } }
      : { landed, restaged: null }
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

// ── Universal capture's delivery half ───────────────────────────────────
//
// CAPTURE IS UNMODED (§2). A copy or a screenshot made during ANY hot mic lands
// in the buffer at the position it happened — armed or not. The scratchpad
// decides WHEN the buffer leaves, never WHAT goes into it.
//
// Everything above records that faithfully on the unarmed path too: beginSegment
// opens a pad for every capture, both watchers arm, recordInsert positions what
// arrives. What was missing was the other end. `render` had exactly one caller
// chain (deliver → takeForDelivery → runDelivery → the scratchpad's own delivery
// seam), so an ordinary unarmed stop pasted the transcript alone and the next
// beginSegment deleted the pad, inserts and all. A ⌘C mid-dictation cost the
// user a chunk boundary and gave back nothing — and it was a REGRESSION, since
// the ledger this branch deleted did stage a screenshot and paste it after the
// text.
//
// This closes it, and the ONE rule that outranks the feature is structural
// rather than argued.

/** The text an UNARMED stop actually delivers: the speech it already has, with
 *  everything captured during that same recording rendered in around it.
 *
 *  NULL MEANS "SEND EXACTLY WHAT YOU HAVE", and that is how the fast path is
 *  protected. When nothing was copied — the overwhelming majority of dictations
 *  — this returns null before touching the renderer at all, and the caller
 *  delivers the very string it was already holding: not an equal string, the
 *  same one. Byte-identity is therefore a property of the CONTROL FLOW, not a
 *  claim about `render` (which trims, and so would differ on any transcript
 *  with a trailing newline). No pad, nothing in it, armed, or no insert in it:
 *  the fast path does not move.
 *
 *  IT MUTATES NOTHING. No setSegmentText on the live pad, no persist, no
 *  announce — the pad is read, a copy is rendered, and the pad is dropped at the
 *  next beginSegment exactly as before. An unarmed pad is not held work and this
 *  must not make it look like any.
 *
 *  THE TEXT ARRIVES ALREADY FORMATTED and is used as-is. The caller composes
 *  AFTER its own maybeCleanupDictation + formatOutputForUser, so the speech gets
 *  precisely the treatment it gets today and gets it exactly once. This path
 *  deliberately does NOT go through formatForDelivery, which exists for the
 *  scratchpad's own delivery, where the pad holds a cleaned transcript that has
 *  never been formatted.
 *
 *  A blank or junk transcript contributes NO segment rather than the literal
 *  word "[BLANK_AUDIO]" — the same rule holdIfArmed applies when holding.
 *
 *  NO SPEECH MEANS NO DELIVERY, AND THAT RULE LIVES HERE. Every caller reached
 *  this function on a path where the transcript could turn out to be nothing:
 *  the sequential dictation flow's quiet-miss sets `output = ''` and FALLS
 *  THROUGH to its delivery site, so a dictation that captured no usable speech
 *  but during which the user copied a URL rendered the insert on its own and
 *  pasted the bare URL. Before universal capture, nothing was pasted at all.
 *
 *  Composing is only ever a REFINEMENT of speech that is already being
 *  delivered (§2 — an insert lands "at the point it happened", and with nothing
 *  said there is no point). So a caller with nothing to say gets `null` and
 *  delivers exactly what it had, which is nothing.
 *
 *  It is guarded here rather than at each call site on purpose: there are four
 *  delivery sites, each with its own junk/quiet-miss handling, and one of them
 *  already got it wrong. A guard at the composer cannot be bypassed by the
 *  fifth. */
export function composeWithInserts(
  segmentId: string | null,
  text: string,
  dest: Destination,
  out?: { attachments: string[] },
): string | null {
  if (armed || !pad) return null
  if (!pad.entries.some((e) => e.type === 'insert')) return null
  const spoken = (text || '').trim()
  const said = spoken && spoken !== '[BLANK_AUDIO]' ? spoken : ''
  if (!said) return null
  const known = !!segmentId
    && pad.entries.some((e) => e.type === 'segment' && e.id === segmentId)
  const composed = known
    // SPLIT, so a copy lands where it happened rather than after every word —
    // see withSplitSegment. One piece (nothing captured inside the stretch, no
    // sentence boundary to cut at) is the old single-segment shape exactly.
    ? withSplitSegment(pad, segmentId as string, said)
    // startMs 0 is exact here, not a guess: this runs only while UNARMED, and
    // beginSegment builds a fresh pad for every unarmed capture — so the pad
    // was created at this capture's start and its clock origin IS that start.
    // No endMs to speak of, so there is no stretch to position inside; the
    // speech appends, which is what a recovered segment can honestly claim.
    : addSegment(pad, { id: randomUUID(), text: said, startMs: 0, endMs: 0 })
  const rendered = render(composed, dest)
  // Nothing renderable came of it. Fall back rather than paste emptiness over
  // the user's transcript.
  if (!rendered.text.trim()) return null
  // THE ATTACHMENTS COME FROM THE SAME RENDER, never from a second walk of the
  // pad — an image the text and the attachment list disagreed about would be
  // pasted twice or not at all. Filled ONLY on the composing path: every
  // `return null` above means this delivery is the untouched fast path, and a
  // caller that reads this field after a null has been handed nothing to
  // deliver. (An out-param rather than a richer return type because the null
  // return IS the byte-identity guarantee — see the header — and every caller
  // spells it `composeWithInserts(...) ?? output`.)
  if (out) out.attachments = rendered.attachments
  return rendered.text
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
  announcePad()
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
 *  has to put a pad back on disk that is no longer in the live slot.
 *
 *  AN EMPTY PAD IS NOT WRITTEN — IT IS REMOVED. An armed tap on silence writes
 *  pad.json while the segment is still open, then the blank transcript comes
 *  back and the segment is dropped, leaving a pad.json holding zero entries.
 *  adoptPersistedPad skips it (isEmpty), so nothing ever reads it again and
 *  nothing ever deletes it: one directory of cruft under ~/.unmute per silent
 *  armed tap, forever. There is nothing in it to keep, so it should not be
 *  there — and taking the directory also sweeps up any image a REFUSED insert's
 *  rescue child left behind in it.
 *
 *  ONLY BETWEEN CAPTURES. During one, a rescue child may be writing into this
 *  very directory, and pulling it out from under an in-flight osascript would
 *  lose an image the user deliberately captured. So while a segment is open an
 *  empty pad is simply not written — it holds nothing, so there is nothing to
 *  survive a crash — and the removal happens at the next persist after the mic
 *  goes cold, when both watchers are disarmed. (The check reads the live
 *  capture's state; the non-live callers, restage and settle, only ever pass a
 *  pad that is non-empty by construction.) */
function writePad(p: Pad): void {
  if (isEmpty(p)) {
    if (!openSegmentId) discardPadFiles(p)
    return
  }
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
// The result is the user's own selection at the top of every dictation that
// started from a selection — silently, and on the fast path.
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
  pasteFn = null
  historyCopyFn = null
  formatFn = null
  settingsFn = null
  padObserver = null
  clipboardWatch = null
  screenshotWatch = null
  watchersArmed = false
  clearOwnSequenceTimer()
  ownSequenceDepth = 0
  suppressDetectedUpTo = 0
  ownSequenceCeilingMs = OWN_SEQUENCE_MAX_MS
  sharedClaims.claims.clear()
  scratchpadRoot = SCRATCHPAD_ROOT
}
