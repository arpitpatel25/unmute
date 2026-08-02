# Pack D — Notch: decisions

Written for someone who was not here. Everything below is a judgement the SPEC
did not dictate, or something found on the way that contradicts it.

Branch `arpit/launch-notch`. Files touched: `desktop/native-notch/**` only, plus
this document.

---

## 1. The shape got a new API, and it is one path with two kinds of corner

`NotchShape` now takes `(bottomRadius, topFillet)` and its `animatableData` is
an `AnimatablePair` of the two, so both interpolate together.

The path is drawn so the **fillets live inside the rect**: the mass body is the
rect inset by `topFillet` on each side, and the concave flare fills that inset
back out along the top edge. A caller therefore sizes the window to
`body + 2 × fillet` (`MassPlacement.width`) and pads content by `fillet`
(`NotchView.barRow`, `NotchView.plane`).

**Why inside the rect rather than outside it.** The alternative is a shape that
overdraws its bounds. SwiftUI clips a `Shape` to its frame, so a fillet drawn
outside would be cut off, and the window would have to be widened by an amount
the shape itself did not know about — which is the fixed-size-overlay bug in a
different costume. With the fillet inside the rect there is exactly one number
and the window, the path and the content padding all read the same one.

**The path knows nothing about the cutout.** It does not take a cutout width and
it does not carve a hole. The mass simply runs through: the controller positions
the window so the mass's middle lands on the housing (`NotchGeometry.barFrame`)
and the view leaves that middle empty (`barRow`). Those pixels are not
displayed, so drawing across them costs nothing — which is the whole argument in
SPEC §2.1, taken literally.

`NotchTongueShape` was **deleted**. It drew the notch-plus-tongue surface that
hung below the bar, which is the bug this pack exists to remove.

## 2. Corner radii are derived from the measured bar, because macOS will not say

`NotchGeometry.filletOfBar = 0.30` and `cornerOfBar = 0.30`, both multiplied by
the measured bar height. On a notched 14"/16" MacBook (37pt inset) that is 11pt;
on a plain 24pt bar it scales to 7pt.

macOS exposes the notch's **position and width** (`auxiliaryTopLeftArea` /
`auxiliaryTopRightArea`) but **not its corner radius**. There is no API, private
or otherwise, that returns it. Deriving from the one number the OS does give
means the radius tracks display scaling instead of being right on one machine.

**The direction of error matters and it is documented here for whoever tunes
it.** The mass's outer bottom corner sits at the same place as the housing's
own bottom corner whenever a half is empty (idle: left segment only, so the
mass's right end is the cutout's right edge). If our radius is **larger** than
the hardware's, our black recedes into a region that has no pixels — invisible.
If it is **smaller**, our black protrudes past the housing's curve as a small
bump on the menu bar — visible. So err large. The knob is
`NotchGeometry.cornerOfBar`, one line, one number.

This is the single most likely thing to need a nudge after someone looks at a
real MacBook. It is called out as an escalation below.

## 3. The bar height is measured three ways, in preference order

`NotchGeometry.current`:

1. a notched display's `safeAreaInsets.top` — which is also the housing's
   height, which is why the mass and the cutout share a bottom edge for free
2. `frame.maxY − visibleFrame.maxY` — the menu bar exactly, at whatever scaling
   the user is running
3. `NSStatusBar.system.thickness` — for an auto-hidden menu bar, where (2)
   measures zero

No literal anywhere in the chain. The old `dummyMenuBarHeight = 24` and
`dummyNotchWidth = 190` are gone.

## 4. `UNMUTE_FAKE_NOTCH` now fakes only the cutout

It used to fake a 200pt cutout **and** a 37pt bar. Faking the bar defeats the
purpose: the harness exists so the notched layout can be looked at on hardware
that has no notch, and a simulation that also lies about the bar height would
hide the very "does it sit level with the bar" question being tested. It now
uses the real measured bar and a cutout of
`screenWidth × estimatedCutoutFraction (0.13)`.

`estimatedCutoutFraction` is the only fraction standing in for a cutout, and it
is reachable in exactly two places: the test harness, and a display that reports
a top safe-area inset but refuses to report the auxiliary areas either side
(never observed — the API has answered on every notched Mac since Monterey).
The second case logs loudly. A fraction was chosen over a pixel count so it
degrades sensibly rather than being wrong by a fixed amount on a machine Apple
has not shipped yet.

## 5. Dormant is asymmetric between displays, deliberately

SPEC §2.3 says dormant renders nothing on both. That is what ships, but the two
displays get there differently:

- **Notched:** the window is the cutout, inset by 1pt so no black can spill past
  the hardware's rounded corners, and it fills black. Nothing new is visible —
  those pixels are behind the housing — and the pointer can still find the
  surface there, which is the gesture people already know from every notch app.
- **No cutout:** the window is 2pt wide and draws nothing at all. There is
  nowhere to hide, so nothing is reserved.

**The consequence, stated plainly:** on an external display, dormant is
effectively un-hoverable — the target is a 2pt column at the dead centre of the
menu bar and nobody will find it by accident. Making it findable means drawing
something, and drawing something is what the spec removed: macOS routes mouse
events by window shape, so a window with no opaque pixels receives neither
clicks nor mouse-moved. You cannot have "invisible" and "hoverable" at once. The surface returns when the engine has something
to say, which is what SPEC §2.3 asks for ("an always-visible idle indicator stops
being an indicator"). This removes the old 9pt dormant sliver that field
feedback had asked for; if that turns out to be missed on external displays, the
fix is a deliberate reversal of the spec, not a bug.

## 6. Attention glows on the *inside*

SPEC §2.3 wants attention to be the only state that glows. A drop shadow cannot
be used: the window is exactly menu-bar height, and a shadow would have to hang
below the bar — which §2 forbids in every unexpanded state. Widening the window
to make room would put an invisible click-eating region over the menu bar.

So the glow is an inner one: a blurred amber stroke along the inside of the path
plus a crisp thin stroke, clipped to the shape (`NotchView.alarmGlow`). Amber
also arrives as the dot and the left label.

**The full-surface amber wash was removed.** The old surface tinted the whole
material for attention. Under D5 the mass is opaque black *always*, and a
tinted mass would be a different colour from the housing it continues — putting
the seam back exactly where §2.1 removes it. Attention is amber at its edges and
in its words, and black across the middle.

## 7. One spring, and the window frame samples it by hand

`Theme.springResponse = 0.34` / `Theme.springDamping = 0.82` are declared once.
Both sides of every resize read them:

- SwiftUI: `Theme.morph` (`.spring(response:dampingFraction:)`)
- the NSWindow frame: `Theme.springSolver`, a closed-form solution of the same
  damped oscillator, ticked at 120Hz by `FrameSpring` in `NotchWindow.swift`

**Why the hand-rolled solver.** An NSWindow's frame cannot be animated by
SwiftUI, and `NSAnimationContext` offers only bezier timing — the previous code
ran the frame on a cubic bezier while the content sprang, which is two curves on
one object. It also makes the axis stagger free: width and height are sampled
independently with different start times, `x` travels with the width and `y`
with the height, which keeps the top-pinned, cutout-anchored placement correct
at both ends of the journey and everywhere in between.

`Theme.collapse` (a second, snappier spring) was **deleted** and its two call
sites — `PillView`, `ScratchpadView` — now use `Theme.morph`. The scratchpad
adopting the new motion curve is explicitly permitted by SPEC §8; nothing else
about it changed.

`Theme.radius(for:)` was also deleted. The bar-level radius is a property of the
screen now, not of the state.

## 8. Content mapping: what each state says, and what hover adds

`BarContent.make` is the state table in code. Hover adds exactly one level:

| State | Left | Right | Hover adds |
|---|---|---|---|
| dormant | — | — | — |
| idle | wordmark | — | the count, on the right |
| active | dot + count | current activity | the task's **name** in place of the activity |
| attention | dot + "Needs you" (+ count badge) | the question | nothing (already maximal) |

Hover also grows each non-empty half by 6pt. That number is a judgement: enough
to register as a response, nowhere near enough to read as opening.

`BarContent` owns both the strings **and** their measured widths, using the same
fonts the view renders. This is the one thing the old code got structurally
wrong — the window was sized in `AppController` and the text was rendered in
`NotchView`, and the two drifted.

## 9. Overflow numbers

- `minRightSegment = 54` — below this the right half is dropped entirely rather
  than ellipsised. 54pt is about six characters plus its padding; anything less
  is an ellipsis pretending to be information.
- `barEdgeKeepOut = 24` — breathing room kept between the mass and the far end
  of the bar, so it cannot collide with the clock or the leftmost app menu.
- `segmentGap = 18` — what separates the two halves on a display with no cutout.
- The left half is **never** truncated. It is clamped by nothing; it is short by
  construction ("unmute", "3 running", "Needs you").

## 10. Auto-present: an additive IPC command, and nothing on the engine side

SPEC §7 says this pack reads the setting and honours it. There was no channel.

**Added:** `{"type":"autoPresent","on":<bool>}`. Absent or malformed ⇒ **on**,
which matches the engine's own default (`overlayAutoPresent: true` in
`electron/remote/init.ts`). An engine that never sends it leaves the surface at
its default; an older helper receiving it falls through to `.unknown` and
ignores it. No existing field changed shape.

**The engine side is not this pack's to write.** Two lines are needed and are
listed in the report: send it next to the existing `appearance` push at
`init.ts:2642`, and again from the `remote:set-overlay-auto-present` handler at
`init.ts:3376`.

**How "never expands itself" is decided.** The helper cannot see the engine's
reason for a state. But it can see its own gestures: `NotchController` engages
`task`/`cockpit` only from `onTap`, `onFocusTask` and `openDashboard` — all of
which are events *this process emitted* (verified by reading
`electron/remote/notch/notch-controller.ts`; nothing else sets `engaged`). So an
expanded rung arriving with **no gesture from this surface in the last 6
seconds** is by definition an automatic present, and with the setting off it is
answered at bar level instead (attention → active → idle, by what is true) with
the content still updated in place.

The 6-second window is a judgement. The engine reconciles on an 80ms debounce,
so anything above ~1s is safe; 6 leaves room for a slow round trip without being
long enough to let a genuinely automatic present through.

**Known limit:** if the engine ever gains a path that expands the notch without a
gesture from the surface — a voice command routed straight to `openCockpit`, say
— that path would be suppressed while the setting is off. It does not exist
today. The clean fix, when it does, is for the engine to say *why* it is
expanding rather than for the helper to infer it.

## 11. Per-display re-evaluation happens on four triggers, not one

`AppController.observeScreens` now watches:

- `NSApplication.didChangeScreenParametersNotification` — connect, disconnect,
  rearrange, resolution, scaling
- `NSWindow.didChangeScreenNotification` on our own panel — the surface moved
  between screens without the screen list changing
- `NSWindow.didChangeBackingPropertiesNotification` — a scale-factor change that
  moves the menu bar's point height without changing the screen list
- plus `syncGeometry()` at the top of every state change, which re-measures and
  returns immediately when nothing moved

`NotchGeometry.screen(hosting:)` resolves the layout from the screen the surface
is actually on, falling back to the primary display. It deliberately refuses a
non-primary screen: there is no menu bar row to be level with there, and
`NSScreen.main` follows the cursor (the original external-monitor bug, whose
comment is preserved).

## 12. What is now covered by an automated check

`Checks/run.sh` grew from a scratchpad decode test into the layout/shape/motion
test as well, and compiles the real `NotchGeometry`, `NotchShape` and
`BarContent` (no windows, no NSScreen — the screen measurements are handed in).
78 assertions, including: the unexpanded frame is menu-bar height and pinned to
the screen's top edge; the mass's middle lands exactly on the cutout; the right
half truncates then drops while the left never truncates; the fillet is present
in the path and is concave; only the outer bottom corners carry a radius; the
spring overshoots and settles; and the `autoPresent` default is on.

Run it with `sh desktop/native-notch/Checks/run.sh`.

## 13. Four things an independent verifier found, and what was done

The verification pass returned no failed assertion but four defects the
checklist does not cover. Three were real and are fixed; one is a known
limitation now made visible.

1. **Attention did not glow while auto-present was off.** `alarmGlow` was gated
   on `commandedState == .attention` as well as the rendered state — a guard
   inherited from when the mass carried a full-surface tint that could survive
   into a task-sized frame mid-morph. With auto-present off, `commandedState`
   holds the expanded rung the engine asked for while the surface is
   deliberately held at attention, so the one state that must glow was the one
   that did not. The guard is now structural (this branch is only reached at bar
   level; expanded draws glass) so the extra condition was **removed**.

2. **`leftUsable` was measured and never read.** The left half is not truncated
   by design, but if it ever outgrew the bar beside the cutout, `barFrame`'s
   screen-edge clamp would silently slide the whole mass off the anchor and open
   the join. It now **logs** that condition (`NotchGeometry.mass`). Still not
   truncated — just no longer mysterious.

3. **The frame spring ran on a `Timer`.** Timer jitter under main-thread load
   shows up as stutter that the SwiftUI side of the same spring does not share.
   `FrameSpring` now uses `NSWindow.displayLink(target:selector:)` on macOS 14+
   and keeps the 120Hz timer as the floor for macOS 13.

4. **Toasts and the skill-review popup have nowhere to go at bar level.** The
   unexpanded surface is menu-bar height and nothing may hang below it, so both
   were being clipped to a sliver — silently, and already before this pack (the
   old 34pt strip could not show them either). They are now drawn **only when
   expanded**, and a toast that arrives collapsed is logged
   (`AppController.showToast`). **This is a gap, not a fix:** the engine sends
   toasts in response to user actions ("finish the recording first — the pad is
   still held") and those still do not reach the user while the surface rests.
   Giving the toast its own short-lived surface below the bar is the obvious
   answer and is deliberately not attempted here — it is a new surface, not a
   change to this one.

## 14. Three more, from the second verification round

1. **`@Published var commandedState` was deleted from `NotchModel`.** It existed
   so a view could refuse to carry an appearance into a state it had already
   left — specifically the attention colour wash surviving into a task-sized
   frame mid-morph. That wash is gone (the mass is opaque black in every state)
   and the separation is now structural: the mass is drawn only at bar level and
   the expanded panel draws glass. Once the glow stopped reading it (§13.1)
   nothing read it at all, and a published value nobody reads is the same defect
   as `leftUsable` was. `AppController` keeps its own private copy, which the
   hover ladder still needs to know what main actually asked for.

2. **`FrameSpring`'s retain cycle is deliberate and is now commented as such.**
   The run loop owns the `CADisplayLink`, the link owns its target, and that is
   what keeps the animator alive for the half second it is animating —
   `NotchWindow.frameSpring` is the other half. `cancel()` breaks both and every
   exit path calls it. Making `link` weak, or weakening the target, deallocates
   the animator mid-morph and freezes the surface part-way to its new size. The
   comment says so at the site, because this is exactly the shape of thing a
   later reader "fixes".

3. **A review proposal that arrives while collapsed is dropped, not held.**
   `SkillPopupView` is now drawn only on the expanded surface (§13.4), and the
   proposal reply is asynchronous — the request is always made from the cockpit
   (`WallView` is the only thing that sets `proposalLoadingId`), but the user can
   collapse while it is in flight. A held-but-invisible popup is worse than a
   dropped one, because `stepDown` consumes a live proposal *before* it steps the
   surface down: the next Escape would have silently dismissed something nobody
   could see instead of collapsing the surface. Three changes, all in
   `AppController`:
   - `handle(.proposal)` drops and logs it when the surface is not expanded
   - `applyState` clears any live proposal on the way down to bar level, ending
     the review conversation exactly as Escape would
   - `stepDown` only lets a proposal swallow the Escape while expanded

   The alternative — assuming the engine only ever replies while expanded — was
   rejected: it is true of the *request*, not of the *reply*, and nothing on
   either side enforces it.

---

## Contradictions and gaps found in the SPEC

1. **§2.3 "Dormant | nothing | nothing" cannot coexist with hover-to-reveal on a
   display without a cutout.** macOS routes mouse events by window shape. The
   spec was followed; the consequence is recorded in §5 above.

2. **§2.3 "Attention … the only state that glows" versus §6/D5 "the bar-level
   mass is opaque black, always."** A glow that reads as a glow is normally a
   drop shadow, and a drop shadow on a menu-bar-height window would hang below
   the bar, which §2 forbids. Resolved as an inner glow (§6 above). A human
   should confirm it reads as "glowing" rather than "outlined".

3. **§7 assumes a channel for the auto-present setting that does not exist.**
   Added additively; the engine side is flagged, not written (§10 above).

4. **§2.1 "matching the radius macOS uses for the cutout itself" is not
   obtainable.** macOS does not expose it. Derived instead (§2 above).

5. **The states table renames a rung.** The spec's "Task" state is `active` in
   `NotchState`, and `task` is the *expanded* task surface. No enum was renamed —
   it is the wire format shared with the engine, which this pack does not own.
