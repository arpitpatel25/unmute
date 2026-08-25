# Capture route late-binding — switching lanes mid-capture, and resolving the target at submit

**Status:** approved for implementation
**Date:** 2026-08-26
**Branch:** `arpit/capture-route-late-binding`
**Base:** `origin/main` at `f8ae6db`

Today a capture's destination is welded to the key that started it, at the
instant it was pressed. Both halves of that are wrong for how people actually
speak: they change their mind about *where* an utterance should go while they
are still saying it, and the task they mean is the one they are looking at when
they finish, not the one that happened to be on screen when they began.

This spec makes the destination **late-bound**: chosen at submit, from state
that stays live for the whole capture, without ever losing a syllable of what
was already recorded.

---

## 1. Scope

**In scope:**

- Switching between the three capture lanes — `cursor` (fn), `task`
  (right-Option), `agent` (right-Command) — freely, any number of times, while
  the mic is hot, with the recording, the transcript-in-progress and the
  scratchpad all preserved across every switch.
- The same switch across a **scratchpad pause**: a held capture resumed with a
  different lane's key continues into that lane.
- Resolving right-Option's target task **at submit** from the live pocket /
  expanded-task state, instead of snapshotting it at key-down.
- Stopping an Agent capture from being associated with a visible task.

**Explicitly out of scope:**

- **Push-to-talk and double-tap-push.** Switching is tap-toggle only. Those two
  activation modes keep today's behaviour byte-for-byte, including today's
  refusal of the other lanes. (Double-tap-push is slated for removal anyway.)
- **Caps Lock / Instruct.** A separate two-part dictation+instruction flow, not
  a destination. Its mutual exclusion is unchanged.
- **The notetaker lane.** `notesActive` is deliberately outside the lock group
  and stays there.
- **Switching after submit.** The window is exactly "while the mic is hot".
- **A live "this is going to X" route indicator on the pill.** Deliberately
  deferred — the pill's `kind` badge already distinguishes dictation from
  remote, and a third state is a design question of its own.

---

## 2. Vocabulary

```ts
type CaptureRoute = 'cursor' | 'task' | 'agent'
```

The same three values `Destination` already uses in `capture/types.ts`, so the
pad's origin and the capture's route are one vocabulary rather than two that
must be mapped. `mode-router.ts`'s `CaptureDestination` spells the third value
`'unmute-agent'`; that spelling stays confined to the dispatch boundary.

Each lane's key keeps its own start gesture and its own stop gesture:

| Route | Key | Start | Submit |
|---|---|---|---|
| `cursor` | fn | tap | tap |
| `task` | right-Option | tap | tap |
| `agent` | right-Command | double-tap | single tap |

---

## 3. The one structural rule

**A switch is a mutation of one field on one live session. It is never a stop
followed by a start.**

One `sessionId`, one `captureSegmentId`, one recorder, one lane lock, from the
first press to the submit. Nothing ends, so there is nothing to tear down, and
the existing teardown — which fires exactly once, at the end, and is the only
thing that clears the lane locks — keeps working unchanged.

A switch is therefore **forbidden** from calling any of:
`startRecording`, `stopRecording`, `startSession`, `beginSegment`.

That list is not stylistic. §7 records what each of them would break.

---

## 4. The press decision

A new pure module, `engine-overrides/electron/captureRoute.ts`, answers one
question with no knowledge of Electron, the session, or the keyboard's fields:

```ts
type PressAction = 'start' | 'submit' | 'switch' | 'ignore'

decidePress({
  lane,                 // which key was pressed
  live,                 // CaptureRoute | null — what is recording right now
  instructionActive,    // Caps Lock owns the mic
  activationMode,       // fn's mode; only constrains the cursor lane
  laneAvailable,        // this lane's own gate already said yes
}): PressAction
```

Rules, in order:

1. `instructionActive` → `'ignore'`. Caps Lock is untouched by this feature.
2. `live === null` → `'start'` if `laneAvailable`, else `'ignore'`.
3. `live === lane` → `'submit'`. **Unconditional** — once a capture is live,
   nothing may stand between the user and stopping it. This preserves the
   property that has kept the right-Option lane from ever wedging.
4. `live !== lane` → a switch is proposed:
   - refused (`'ignore'`) when either side is the cursor lane and
     `activationMode !== 'tap-toggle'`;
   - refused (`'ignore'`) when `!laneAvailable`;
   - otherwise `'switch'`.

Rule 3 sitting above rule 4 is what makes gates un-wedgeable: a gate can only
ever refuse a *start* or a *switch into* a lane, never a submit or a switch
*out of* one.

### Lane availability

`task` is gated by `isRemoteTriggerEnabled()` (plan entitlement + the session
toggle), already imported by `keyboard.ts`.

`agent` is gated by availability, which today is checked in `init.ts` **after**
`keyboard.ts` has already set `agentActive = true` — so an unavailable Agent
latches the lane lock with no session behind it, and only a subsequent
dictation clears it. That is a live bug, and once locks decide switching it
becomes a worse one. A new `engine-overrides/electron/agentTriggerGate.ts`,
modelled exactly on `remoteTriggerGate.ts` (dependency-free, pushed by the
paywall layer, read by the keyboard), moves the check ahead of the mutation.

---

## 5. What each layer does

### 5.1 `keyboard.ts`

The four lane booleans (`dictationActive`, `instructionActive`, `remoteActive`,
`agentActive`) stay exactly as they are and remain authoritative. They are
entangled with the chain timer, the Caps Lock chain and the dual-mode state
machine, and rewriting them wholesale would put every one of those paths at
risk for no gain.

Added instead:

- `private liveRoute(): CaptureRoute | null` — a read-only derivation from the
  booleans. Not a second source of truth.
- `private applyRouteSwitch(to: CaptureRoute): void` — the **single** place all
  three booleans move together, so "at most one lane is live" is enforced in
  one function rather than asserted at four call sites.
- A new event `{ type: 'capture-route'; route: CaptureRoute }`, emitted by
  `applyRouteSwitch` and by nothing else. It carries no session lifecycle
  meaning: no `session-start`, no `session-stop`, no `chain-*`.

The three start branches (`handleRemoteKeyDown`, `feedAgentGesture`,
`handleTapToggleDown`) consult `decidePress` instead of their inline exclusion
checks. Every other branch is untouched.

### 5.2 `sessionManager.ts`

`SessionState` gains `route: CaptureRoute` as the single truth. `kind` and
`agentAddressed` become **derived** from it rather than independently stamped:

```
route 'cursor' → kind 'dictation', agentAddressed false
route 'task'   → kind 'remote',    agentAddressed false
route 'agent'  → kind 'remote',    agentAddressed true
```

New method `setCaptureRoute(route)`, the only writer, which:

1. refuses unless a session exists, its status is `'recording'`, and
   `isProcessing` is false;
2. writes `session.route`;
3. calls `setPadOrigin(route)` (§5.3) — never `beginSegment`;
4. re-pushes the **full** pill chip set for the new lane (§7.2);
5. notifies the widget over a badge-only channel (§5.5).

`startSession` gains an explicit guard: it already silently reuses a live
session without re-stamping it, which is unreachable today only because mutual
exclusion blocks the second key. It now refuses loudly instead.

**Selection capture** splits into its two real questions, which were conflated
because key and route used to be the same thing:

- *Whether* to grab is a function of the **final route** (`cursor` needs it;
  `task`/`agent` grab it for context).
- *Whether to defer* the grab to key-release is a function of the
  **physically-held key** — the deferral exists because a synthesised ⌘C landing
  while Option is held becomes ⌘⌥C, which Chrome reads as Inspect Element.

**Submit path** is selected by the final route, not by the key that submitted:
`cursor` takes `stopRecording` + the chain window; `task`/`agent` take the
`stopRemoteCapture` shape (deferred grab, wait for audio, process immediately).

`dispatchFromCapture` receives the route explicitly, alongside the target id.

### 5.3 `capture/index.ts`

Two changes, both narrow:

- **`setPadOrigin(origin: Destination): void`** — mutates the current pad's
  origin in place and announces. Touches nothing else. This is what a
  mid-capture switch calls.
- **`beginSegment` updates an existing armed pad's origin.** Today the origin
  is only set when a pad is *created*, so a pad that survives a pause keeps the
  origin of whichever capture created it. That is what makes the pause-then-
  other-key case work: pause a dictation, press right-Option, and the pad's
  offered destinations follow.

The rule both changes serve: **the pad's origin always equals the route of the
most recent capture.** It decides which buttons the scratchpad panel offers
(`pad.origin === 'agent'` restricts the panel to the Agent alone), so a stale
origin is a panel that offers the wrong destinations for the work it is
holding.

### 5.4 `init.ts`

- Handles `capture-route` → `sessionManager.setCaptureRoute(route)`, plus the
  overlay-Escape pause (idempotent — `pauseOverlayEscape` is a plain release,
  not a counter) and the capture-phase re-broadcast.
- **Deletes the `captureAddress` module global.** It mirrors the address
  outside the session, which is what caused the 2026-08-18 incident where a
  cancelled Agent capture silently readdressed every subsequent Remote press;
  it still has a live hole, since the addressed-task branch returns before
  `advanceCaptureAddress('dispatched')` ever spends it. The route on the
  session gives the same property structurally, because the session is nulled
  on all fourteen teardown paths. `capture/captureAddress.ts` and its test are
  removed with it.
- **Late-binds the target.** The key-down snapshot at the `remote-start`
  handler is replaced by `null`; `dispatchFromCaptureInner` already falls back
  to the live `orchestrateFocusId`, which `applyVoiceTarget()` in
  `notch-controller.ts` already keeps exactly in step with the pocket and the
  expanded task — pocket open aims at the current slot, pocket closed means the
  router. No new state.
- **Keeps the pill honest** by re-pushing chips when focus moves during a live
  capture, from the two existing `orchestrateFocusId` writers.
- **Guards the Agent's task association.** `submitUnmuteAgent` falls back to
  `notchController.focusedComposerTaskId()` for `activeTaskId`; when the
  capture is addressed to the Agent by its own key, that fallback is skipped.
  Pressing the Agent key is a statement about who you are talking to; a
  composer having focus is not.
- **Wires `onCaptureEnded()`**, which is declared in `KeyboardManagerLike`,
  implemented in `keyboard.ts`, and has never had a single call site — its own
  header says so and it is still true. Every path where `init.ts` refuses a
  capture the keyboard has already latched now calls it.

### 5.5 `notch-controller.ts`

`notifyCapturePhase` falls back to the focused task's title when `taskId` is
null, so an Agent capture — which is always null — displays the focused pocket
task as its target while dispatching correctly to the Agent. The fallback is
removed: an absent target renders as absent.

### 5.6 Widget

A badge-only channel. The route change must **never** re-fire `recording:start`
— that handler calls `startRecording()`, which re-acquires the mic and loses
the audio recorded so far. `isRemote` already self-clears when the pill leaves
an active state, so no new teardown is needed.

---

## 6. The scratchpad, held work, and pause

An armed pad survives across captures, and `holdIfArmed` sits above the
delivery split, so an armed capture on any route holds rather than delivers.
Switching therefore changes nothing about *whether* held work is delivered —
only about which destinations the panel offers for it, via the pad origin rule
in §5.3.

Concretely, the flow the feature has to support:

1. Pad armed. Tap fn — capture 1 opens on `cursor`.
2. Tap fn — held. Transcript attaches to its segment, nothing is delivered, the
   pill goes `paused`, the session is nulled and the lane locks clear.
3. Tap right-Option — capture 2 opens on `task`, into the **same pad**. The
   pad's origin follows to `task`, so the panel now offers the task
   destinations.
4. Mid-capture, double-tap right-Command — capture 2 switches to `agent`. The
   pad's origin follows again.
5. Send from the panel, or submit with right-Command.

Steps 1–3 already work mechanically today, because nothing is live between them
— the only thing missing is the origin following, which §5.3 supplies.

---

## 7. Hazards this design exists to avoid

Recorded because each is a real failure mode in this exact code, and the
mitigation is only obvious once the failure is written down.

### 7.1 `beginSegment` on a switch

It would discard an unarmed pad and allocate a new one (losing everything
captured in this utterance), mint a second `openSegmentId` (so the transcript
attaches to a fresh empty segment and orphans the real one), and zero
`ownSequenceDepth`/`suppressDetectedUpTo`. That last one is the worst: if an
own-clipboard sequence is in flight — the selection grab shells out to
`osascript` for ~200ms — the matching `endOwnClipboardSequence` then
early-returns at depth 0, `resumeAfterOwnSequence` never runs, and **the
clipboard watcher stays stopped and disarmed for the rest of the recording.**
Copies and screenshots after that point are silently dropped.

Hence §3's prohibition, and `setPadOrigin` as the narrow alternative.

### 7.2 The pill merges

`PillController.push()` is `{...last, ...state}`. A partial push on a switch
leaves the previous lane's agent and model chips on screen. This is already a
known-and-fixed hazard here — `pushPillChips` blanks the agent lane's model
fields explicitly, with a comment recording why. A switch pushes the complete
chip set for the new lane, blanking what the new lane does not own.

### 7.3 No module-level route mirror

See §5.4. The session is the only place the route lives.

### 7.4 Gates must not latch

See §4. Rule 3 above rule 4, plus `agentTriggerGate`, plus wiring
`onCaptureEnded` on the refusal paths.

---

## 8. Invariants, as tests

`keyboard.ts`'s three main lanes have **no** test file today —
`keyboard.notetaker.test.ts` is the only one, and it is excluded from
`npm test`. The switch decision goes in as a pure table, and the lane
transitions get their first coverage.

1. A switch never calls `startRecording`, `stopRecording`, `startSession` or
   `beginSegment`.
2. `liveRoute()` is single-valued; no state has two lanes live.
3. Every path that clears a lane lock today still clears it: submit, Escape,
   too-short, quota, junk-STT, cancel-with-undo.
4. N switches then a submit produce exactly one delivery, to the final route.
5. N switches then Escape produce zero deliveries and leave no lock set.
6. Switching is refused — recording continuing unchanged — when the activation
   mode is not tap-toggle, when Caps Lock owns the mic, when the mic is not
   hot, when processing, or when the target lane's gate says no.
7. After any switch sequence, the next capture starts clean: same assertions as
   a capture that never switched.
8. fn keeps ignoring the other lanes' locks — the deliberate escape hatch when
   something else is wedged.
9. The pad's origin equals the route of the most recent capture, across both a
   mid-capture switch and a pause-and-resume-in-another-lane.
10. An Agent capture never carries a task id, in dispatch or in display.

---

## 9. Not touched

The STT arbiter, VAD and chunking, the correction and cleanup gates,
`micWarm`, the notetaker's `notesActive` lane, and the push-to-talk /
double-tap-push code paths.
