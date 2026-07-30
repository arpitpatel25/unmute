# Composed input capture — design

**Status:** design-complete, approved. No implementation yet.
**Date:** 2026-07-30
**Baseline commit:** `3bb7991`
**Branch:** `arpit/composed-input-capture`

Capture becomes composable: copies and screenshots land in the transcript at the
point they happened, and a scratchpad lets the user hold what they have built
instead of committing it. Plain dictation is unchanged.

---

## 1. The problem

Today the model is **utterance = commit**. You speak, and the moment you stop,
it fires — pasted at the cursor, or dispatched as a task. Finishing speaking and
submitting are the *same act*.

That single fact causes everything we want to fix:

- **You have to be right in one take.** There is no pause to think, no way to
  add a second thought, no way to go and check something. The user described it
  as "a small panic" — you must have the whole instruction formed before you
  press the key.
- **Anything you reference, you have to describe.** "The Slack thread from this
  morning about pricing" — instead of just pasting the link, because there is no
  moment during a capture in which pasting is possible.
- **A capture is all-or-nothing.** Stop early and you have committed something
  half-formed; cancel and you have lost all of it.

## 2. What we are building

Two **independent** axes. Keeping them independent is the core of the design —
an earlier draft fused them into a single "composed mode" and it was worse in
every respect.

| Axis | What it governs | Is it a mode? |
|---|---|---|
| **Capture** | *what goes in* — speech, copies, screenshots, in order | No. Always on. |
| **Retention** | *when it leaves* — drain on stop, or hold | Yes, explicitly armed. |

**Capture is universal and unmoded.** During any hot mic, in any destination, a
copy or a screenshot lands in the buffer at the position it happened. There is
nothing to declare and nothing to turn on.

**Retention is the scratchpad.** An explicit, armable decision that changes what
*stopping* means: drain the buffer to its destination, or keep it.

### 2.1 Why position matters

Speech refers to artifacts deictically:

> "go through the thread from this morning" … ⌘C … "and compare it with what we
> agreed in the doc" … ⌘C … "then draft a reply"

If both links land in a bucket at the end, the agent has to guess which "this"
is which. Kept in order, the reference resolves itself.

**Order carries almost all of that value; exact position is a refinement.** This
distinction governs §5.3 — we are not willing to damage transcription accuracy
to buy exactness, because ordering already delivers the outcome.

## 3. The buffer

One buffer. Always present. Same cardinality as the clipboard — there is no
naming, no list, no management.

```
segment  { speech, startMs, endMs }     one press-to-pause stretch
insert   { kind, content, atMs }        a copy or a screenshot
```

Entries are ordered by time. Segments come from pause/resume; inserts come from
the clipboard. This yields two removal granularities for free: drop a whole
**segment** (a thought you no longer want) or a single **insert** (wrong link).

**Provenance is always retained in the buffer.** Every entry knows whether it was
spoken or pasted. This is *rendered away* per destination (§6) — never discarded
at capture time — because the distinction is real: pasted text is verbatim
ground truth, dictated text has been through STT and may contain errors.

### 3.1 Segments vs. the continuous take

Two levels, and they compose rather than conflict:

- **Within** one press-to-pause stretch, the mic stays hot. The user can leave
  the app, copy, come back, and keep talking. This is where interleaving happens.
- **Across** stretches, the buffer persists and each new stretch appends.

## 4. The state machine

| State | Dictation key (Fn) | Task key (Right-Opt) | Escape |
|---|---|---|---|
| idle, unarmed | start → drains to cursor | start → drains to task | — |
| recording, unarmed | stop + **send** *(today, unchanged)* | *(locked out)* | cancel capture |
| idle, armed | start / resume → appends | start / resume → appends | — |
| recording, armed | pause + **keep** | *(locked out)* | cancel **segment only** |

The existing mutual-exclusion lock (`remoteActive`, `keyboard.ts`) is unchanged:
the two trigger keys never run concurrently.

**The fast path is unchanged.** Unarmed: tap, talk, tap, paste. The gesture, the
timing, and the delivery are exactly what they are today, and when nothing was
copied — the overwhelming majority of dictations — the output is byte-identical.
This is a hard requirement, not a goal. What *can* differ is that a copy made
during an unarmed dictation now appears inline in the pasted text (§2), which is
the intended behaviour of universal capture.

**Escape never destroys the pad.** It cancels the segment in progress. Discard
(§7) is the only path that destroys held work, and it confirms.

## 5. Capture mechanics

Three problems, three answers.

### 5.1 Detection without touching the audio

**Sacred constraint:** no heavy main-process work while recording — it corrupts
the audio (`ffmpeg: Invalid data`). This is why the current screenshot ledger
reads the clipboard exactly twice per capture and cannot report a mid-hold
screenshot until key-lift.

**Detection and reading are separated:**

- `NSPasteboard.changeCount` is a single monotonic integer. Reading it is free
  and can be polled fast (~250ms) on the main thread.
- When it moves, **that timestamp is the insert's position** — recorded
  immediately, at no cost.
- Only then does a child process read the actual content, exactly as
  `probeClipboardViaChild` does today.

Cheap detection on the main thread, expensive reading in a child, and position
is *exact* rather than inferred from file mtimes.

**Screenshots saved to a file need a second detector.** `changeCount` only sees
the pasteboard, which covers ⌃⇧3/⌃⇧4 (copy to clipboard). But the macOS
*default* is ⌘⇧3/⌘⇧4, which writes a file to the screenshot directory and never
touches the clipboard. Covering only the clipboard would silently drop the way
most people actually take a screenshot, gutting half the feature.

So the screenshot directory is watched too — but **event-driven (FSEvents /
`fs.watch`), not the current 900ms `readdir` poll.** This is strictly better on
every axis: it costs nothing while idle, it fires on the actual write rather
than up to 900ms later, and that fire time *is* the insert's position. The
watcher is armed only while the mic is hot (§5.4) and disarmed the moment it
stops, so the filesystem is never observed outside a consented window.

Directory resolution keeps the existing logic (`defaults read
com.apple.screencapture location`, falling back to `~/Desktop`). Name matching
keeps the existing rule: inside a dedicated `Screenshots` folder any image
counts; elsewhere only `Screenshot*`-named files, so an unrelated PNG landing on
the Desktop is never swept in.

### 5.2 Excluding our own clipboard writes — structurally

Unmute writes the pasteboard twice per capture:

- `captureSelection()` synthesises ⌘C at capture start to grab the selection.
- `injectOutput()` writes the transcript to the clipboard in order to paste it.

Naively, both would be observed as user copies.

**Every Unmute write records the `changeCount` it produced; those values are
skipped.** Our own writes become unobservable *by construction*.

This replaces the entire baseline-probe / signature-set / clear-after-consume
apparatus in the current ledger — roughly 300 lines whose only job is to guess
"is this image ours?", a question `changeCount` answers exactly. That guessing is
the reason the current feature is unreliable.

### 5.3 Placing an insert in the text

Speech is transcribed in chunks (`DEFAULT_CHUNK_MIN_MS = 30_000`, hard cap
`45_000`). An insert at t=12.4s falls *inside* a chunk, and chunk text cannot be
split at an arbitrary time without word-level timestamps — which the pipeline
deliberately does not request (`response_format: json`, not `verbose_json`, for
the latency).

**Rejected: forcing a chunk cut on every clipboard event.** It was the first
proposal and it is wrong. The chunking rules are the most carefully-earned part
of the dictation path — the 2026-07-14 investigation established that *cutting
badly is the primary source of garbled transcripts*, and that the hard cap "cuts
mid-word by design" is the failure to avoid. A clipboard-triggered cut has
exactly that failure mode when the user copies while still speaking. Short
chunks also transcribe worse, and every extra boundary is another `promptTail`
handoff where a name or term can drift.

**Adopted: permit, never force.**

1. The insert always records its true timestamp.
2. At assembly it lands at the **next natural chunk boundary** after that
   timestamp.
3. A clipboard event *permits* an early cut — but only when already in sustained
   silence **and** the chunk has passed a floor well below the 30s minimum
   (~8–10s). Never mid-speech; never a sliver of a chunk.

In practice this is near-exact, because you cannot hunt for a link and speak
fluently at the same time — copies land in pauses, and `decideCut` already fires
a silence cut after 400ms of sub-threshold audio. The worst case degrades to "at
the end of the chunk you were in," which is fine because order is preserved
(§2.1).

`decideCut` gains an `'insert'` decision alongside `silence` / `soft-cap` /
`hard-cap`, gated on the silence condition and the lower floor. `promptTail`
carries across the cut so the decoder keeps its context.

### 5.4 Consent

**Capture happens only while the mic is hot.** The recording window is the
consent signal — the rule the codebase already runs on. Pausing closes the
window; a copy made while paused is the user's, not ours. The clipboard is never
observed outside a window the user deliberately opened.

Consequence, accepted: "pause, go find the link, resume" does not capture the
link. Rejected the alternative (watch whenever a pad is open) because it means
observing the clipboard for hours, a step change in what the app sees.

## 6. Classifying and rendering an insert

The system is not intelligent and cannot know what a copied thing *means*. It
does not need to. Every branch is a deterministic check.

### 6.1 Classification (regex, no judgement)

| Test | Kind |
|---|---|
| `^https?://` | url |
| `^/` or `^~/`, and exists on disk | path |
| no `\n`, length < 200 | line |
| **anything else, including unmatched** | **block** |
| image on the pasteboard (⌃⇧3/⌃⇧4), or a screenshot file (⌘⇧3/⌘⇧4) | image |

**Fenced is the default; inline must be earned.** Fencing something short is a
cosmetic annoyance. Inlining something long or unknown wrecks the sentence *and*
destroys the boundary irrecoverably. The unknown case falls to the cheap failure.

### 6.2 Rendering (per destination)

| Kind | Cursor | Task |
|---|---|---|
| url / path / line | inline, raw, spacing normalised | inline, raw, spacing normalised |
| block | fenced | fenced |
| image | skipped (or path) | real reference |

**A fence is a boundary marker, not a claim.** It asserts only *this is
verbatim, it starts here, it ends here* — the one thing we know for certain. It
is the most epistemically humble option available, not the least.

Bare newlines were rejected as a weaker form of the same idea: if the pasted
content itself contains a blank line (stack traces, config files, prose all do),
the boundary is unrecoverable. Fence length escapes by extending the fence past
any run of backticks in the content — also deterministic.

**Never asserted:** no `the user copied:`, no `selected text:`, no `context:`.
Those make claims we cannot support. **And never substitute a deictic word** — if
the user says "look at this" and copies, we do not replace "this" with the link.
That would be wrong constantly and is the kind of cleverness that erodes trust.

## 7. The scratchpad surface

**The icon** lives on the pill, mirroring the mic-source control already there.
It **arms and disarms only — it never sends.**

> Rejected: toggle-off = send. It is a silent commit dressed as a mode switch. A
> toggle *reads* as reversible, so a user tapping it to mean "never mind, I don't
> want the scratchpad" would create a task instead — reintroducing the
> accidental-commit panic at the exit rather than the entrance. It also leaves no
> way to express "throw this away".

**The pad** appears when there is content. It floats near the pill (which is
anchored *bottom-centre* of the primary display's visible frame —
`PillWindow.swift:70`), is expandable/collapsible, and is **non-activating**: if
clicking it took focus, the text insertion point the user is about to paste into
would die.

**Structured rows, not prose:**

```
╭─ scratchpad ─────────────────────────────╮
│ ▸ "go through the thread from…"    0:14 ✕ │
│   🔗 slack.com/archives/C04…           ✕ │
│ ▸ "and compare it with what…"      0:09 ✕ │
│   🖼 Screenshot 14.22.png              ✕ │
│ ▸ "then draft a reply"             0:04 ✕ │
│ ───────────────────────────────────────── │
│ [ new task ]   [ cursor ]     [ discard ] │
╰───────────────────────────────────────────╯
```

Each segment and each insert is one row with `✕`; `▸` expands to read in full.

Rationale: the job at review time is **confirmation, not reading** — the user
said those words thirty seconds ago. What needs checking is whether the right
things are attached and where it is going. A continuous transcript optimises for
the task nobody needs to do, and *cannot honestly preview the output anyway*,
since rendering depends on a destination not yet chosen (§6.2). Structure is
destination-independent.

Naturally compact: a typical pad is 5–8 rows. It grows and scrolls only when it
earns it.

## 8. Destinations

Three destinations plus discard, presented on the pad:

- `new task`
- `add to <focused task>`
- `cursor`
- `discard` (confirms)

**The set is dynamic.** `add to <focused task>` appears only when a task is
actually focused — reusing `orchestrateFocusId`, the short-circuit in
`dispatchFromCaptureInner` that already routes an utterance to a focused session
deterministically.

**The primary defaults to the key the capture opened with** (Fn → cursor,
Right-Option → task), and the pad can override it. Bound at start, decidable at
the end — which matters, because deferring the decision is the entire point.

> Rejected: a keyboard shortcut for send (e.g. double-tap Fn). Three reasons.
> Double-tap on the dictation key is **already taken** — `ActivationMode`
> includes `'double-tap-push'`, where double-tapping Fn starts hands-free
> dictation (`DUAL_DOUBLE_TAP_MS = 400`, `keyboard.ts`); the same gesture would
> mean two things depending on a setting chosen months ago. Send is now a *choice
> among destinations*, and a gesture can only express the default — precisely the
> case where a shortcut is least needed. And the whole design makes commit
> deliberate; a hotkey for commit quietly reopens that door. Revisit only if
> users ask, and not on the dictation key.

## 9. Lifecycle

- **One pad, always exactly one.**
- **Written to disk as you go** — `~/.unmute/remote/scratchpad/`, atomic
  write-tmp-then-rename, the pattern already used by `status.json` and the
  curator store. A crash or a quit never loses it.
- **Settles after ~30 minutes idle:** the pill stops being permanently visible;
  the pad stays on disk. Arming the scratchpad again picks it back up.
- **Never auto-deleted.** Discard is the only way it goes away.

The settle behaviour resolves a real tension: held work must survive, but a pill
pinned open until Friday's draft is dealt with on Monday turns a calm product
into a nagging one. House precedent is that things decay unless deliberate
(one-offs purge at 24h, sessions never do, an ignored `ready` decays after an
hour) — a pad is deliberate, so the *content* persists while the *demand for
attention* decays.

## 10. Module boundaries

House style is pure, dependency-free, exhaustively-tested modules with thin
wiring — `vadPolicy`, `remoteTriggerGate`, `correctionGate`, `sttArbiter`,
`promptTail`. This follows it.

| Module | Pure | Owns |
|---|---|---|
| `captureBuffer.ts` | ✅ | the timeline — segments, inserts, ordering, removal |
| `insertClassify.ts` | ✅ | §6.1 regexes; unknown → block |
| `insertRender.ts` | ✅ | buffer + destination → text; inline vs fenced; fence escaping |
| `clipboardLedger.ts` | ✅ | "is this change ours?" — the own-write skip set; insert dedup |
| `clipboardWatch.ts` | — | `changeCount` polling; child-process content reads |
| `screenshotWatch.ts` | — | FSEvents watch on the screenshot dir; arm/disarm with the mic |
| `scratchpadStore.ts` | — | disk persistence, settle timer |
| native addon | — | expose `NSPasteboard.changeCount` (small addition to `native-paste`) |
| Swift (`native-notch`) | — | pill icon; the pad panel |

**Two seams only**, both thin: `sessionManager.ts` for capture,
`init.ts` for delivery.

`changeCount` belongs in `native-paste` rather than a new addon because that is
already the in-process clipboard owner, and the in-process requirement is the
same one that put paste there: macOS grants TCC by signed bundle identity, so a
spawned helper would have its own identity.

## 11. What this deletes

Net negative lines in the least-testable part of the repo.

Removed from `init.ts` (3,369 lines, most-changed file in the repo, **no test
file of its own**):

- `probeClipboardViaChild` baseline/`markOnly` machinery and `clipBaselined`
- `knownClipSigs` / `sigOf` signature set
- `secureAndClearClipboard` and the clipboard-clear-after-consume behaviour
- `stageRecentScreenshotFiles` mtime scanning and its 900ms interval — the
  *capability* survives, re-implemented event-driven (§5.1); the polling and the
  mtime-comparison heuristic do not
- `startCaptureWatch` / `stopCaptureWatch` / `purgeAutoStaged` and the
  `auto` vs `explicit` `StagedEntry` distinction
- `pendingClipboardCount` — it exists only to paper over the fact that a
  mid-hold clipboard screenshot cannot be read until key-lift, which §5.1
  removes
- `consumeStagedForDictation` seam in `clipboard.ts`

Retained: `screenshotDir()` resolution, and the `Screenshot*` naming rule.

Everything else exists to infer provenance that `changeCount` and a filesystem
event establish exactly.

**Kept, folded in:** explicit paste/drop of an image becomes an ordinary insert
in the same buffer, so the tray concept disappears without losing the capability.

## 12. Testing

Table-driven unit tests on the pure modules, which is where the risk actually
lives:

- **`clipboardLedger`** — *the critical one.* Proves our own synthetic ⌘C and our
  own output write are never observable. This is the entire bug class being
  removed.
- **`insertClassify`** — nasty inputs: URLs with query strings and fragments,
  paths containing spaces, single lines at the 200-char boundary, content that
  is `\n`-only, unmatched content falling to `block`.
- **`insertRender`** — both destinations × every kind; fence escaping when the
  content itself contains backtick runs; spacing normalisation around inline
  inserts.
- **`captureBuffer`** — ordering under interleaved arrival, segment vs insert
  removal, empty and single-entry edges.
- **`vadPolicy`** — the new `'insert'` decision: fires only in sustained silence
  above the floor, never mid-speech, never below it.
- **screenshot name matching** — `Screenshot*` accepted at the top level, any
  image accepted inside a `Screenshots` folder, unrelated Desktop PNGs rejected.

Two behaviours need a live check rather than a unit test, because neither can be
faked meaningfully: that a `⌘⇧4` file and a `⌃⇧4` clipboard capture each land
once and only once (not twice, via both detectors), and that a long composed
capture does not degrade audio — the constraint §5.1 exists to protect.

Wiring (`init.ts`, `sessionManager.ts`) stays untested, consistent with existing
precedent — the modules carry the coverage.

## 13. Explicitly deferred

- **Pad visual design** — exact dimensions, glass/material treatment, animation.
  Structure and behaviour are settled; pixels are not.
- **A send shortcut** — see §8. Revisit only on user demand.
- **Non-clipboard modalities** — the design admits new insert kinds without
  structural change, but none are in scope.
