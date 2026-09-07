# Unmute — native UI replica

Real DOM reproductions of the three surfaces people actually touch: the
**dictation pill**, the **meeting notetaker**, and the **notch**. Open
`index.html` for a gallery of every state.

Nothing here is drawn from a screenshot or from memory. Every number is
transcribed from the app's own source, and the file it came from is named in a
comment beside it.

## Sources this is transcribed from

| Here | From |
|---|---|
| `tokens.css` | `native-notch/Sources/unmute-notch/Theme.swift` |
| `pill.css`, `pill.js` | `PillView.swift`, `PillModel.swift`, `Waveform.swift`, `LevelMeterSupport/{LevelMeter,DotWave}.swift` |
| `notch.css`, `notch.js` | `NotchShape.swift`, `NotchGeometry.swift`, `BarContent.swift`, `NotchView.swift` |
| `expanded.css`, `expanded.js` | `WallView.swift`, `StageView.swift`, `TaskSurfaceView.swift`, `PocketView.swift`, `ConversationPanel.swift`, `SurfaceSizeControls.swift`, the controls in `NotchShape.swift` |
| `notetaker.css`, `notetaker.js` | `engine-overrides/renderer/notetaker/NotetakerWidget.tsx`, `electron/remote/notetakerWidget.ts` |
| `icons.js` → `providerMark` | `ProviderMark.swift`, `ProviderMarkArt.swift` |
| `assets/*.png` | the base64 blobs compiled into `ProviderMarkArt.swift` and `UnMarkArt.swift`, extracted byte-for-byte |

## What is exact, and how it was checked

**Colours.** The status hues are `NSColor.systemGreen` and friends, read out of
AppKit in dark appearance rather than quoted from memory — several differ from
the values usually given for them (`systemOrange` is `#FF9230`, not `#FF9F0A`;
`systemTeal` is `#00D2E0`, not `#64D2FF`).

**Type.** `Font.system` is SF Pro, and on a Mac browser `-apple-system` *is* SF
Pro. The text is the same font at the same sizes, not an approximation.

**Motion.** SwiftUI's `.easeInOut` is exactly `cubic-bezier(0.42, 0, 0.58, 1)`.
Theme uses no springs anywhere, so every duration and curve maps directly:
0.24s surface morph, 0.09/0.14 content out/in with an 0.08 delay, 0.15 hover,
1.2s status breathe, 0.42s bouncing dots at 0.12s apart.

**Geometry.** `verify.mjs` asserts the rendered boxes against the source
constants and fails if they drift — the 36pt cluster height, the 54.5pt
waveform, the 34pt hint chip, the 32pt selector row, the 8/9pt gaps, the rim
being inset rather than a border, and that the notch's middle segment sits
exactly over the camera housing in every state.

```
python3 -m http.server 4180     # from the repo root
node replica/verify.mjs
```

## What is deliberately not exact

- **SF Symbols are not reproduced.** They are licensed for software on Apple
  platforms, so `icons.js` carries hand-drawn equivalents built to the same
  24-unit grid and stroke weight. Unmute's own `NotePenGlyph` *is* transcribed
  exactly — it is our artwork, not Apple's.
- **Live Liquid Glass** samples what is behind the window and no browser can do
  that. It does not matter here: `Appearance.preference` defaults to `.solid`,
  so the surface most people see has no backdrop sampling in it at all.
- **The notch is measured, not fixed.** `NotchGeometry` derives everything from
  `safeAreaInsets` and the auxiliary top areas, so there is no single correct
  width. The gallery states which Mac it is drawing — 200×34 for a 14" Pro,
  168×32 for a 13" Air, both taken from the app's own `UNMUTE_FAKE_NOTCH`
  harness — and every other number derives from it exactly as the app derives
  it (fillet and bottom radius are both `round(barHeight × 0.30)`).

## The two grounds

`Appearance.tone` decides the ground's *colour*; `SurfaceAppearance` decides its
*material*. They are separate settings and the toggle at the top of the page
drives the first. Space Gray — `rgb(22,24,28)` at 94% — is the original and the
default, so nobody's surface changes under them. Black is the same black the
housing itself is, so an expanded surface reads as one object with the mass
above it rather than a grey panel hanging off a black cutout.

Three things move with it, and they are in `Theme.swift` for a reason: the
plane, the user's bubble (roughly double the lift on black, or a conversation
reads as one undifferentiated column), and the composer (a *well* on Space Gray,
a *lift* on black — there is nothing darker than the ground to recess into).
The bar-level mass does not move: it is opaque black in every state and the
appearance setting never reaches it.

## Covered

**Pill** — all nine `PillPhase` values; all three `PillKind` lanes; the
countdown inside the last 15s; hover-to-cancel (the capsule widens, the
waveform does not move); processing with each of its four trailing
affordances; both error variants; the agent·model control connected,
unreachable, terminal-less and in the Agent lane; the selector panel as a flat
list, as Codex's three axes, empty, and addressed to a task; the mic and
scratchpad chips in both positions; all three narration chips; all five
offline reasons.

**Notetaker** — recording, actions-open, saved.

**Notch, bar level** — dormant, idle, the resting nub, active with and without
a badge, attention, the pocket waiting, routing, agent activity, a toast; hover
reveals on each; 14" Pro, 13" Air and an external display; over a light desktop.

**The pocket, open** — one task waiting, one already settled, several held with
the slot rail, the Agent, and a toast.

**The Orchestrator** — the four view tabs, the workspace rail, grouped cards in
one and two columns, a single selected workspace, and both empty states. Tabs
and rail are live; the size track drags.

**A task, opened** — the stage and the single-task attention panel. Right-aligned
user bubbles, collapsed work blocks that open in place, the composer, and the
crank.

## Not built yet

`BlockViews` / `BlockConversation` (the richer block-based transcript that
supersedes `rows` — diffs, exit codes, MCP identity, reasoning), the live
terminal panel (`TerminalHost`), `QuestionBlock`, the skill popup, and the
scratchpad pad (`ScratchpadView`) that hangs off the pill's scratchpad chip.

## One known divergence from the running app

The composer in the shipping build carries a row of chips — agent, model,
access, working directory, and "Right ⌥ to dictate". Those are **not** in
`ConversationPanel.swift` in this checkout of `desktop/native-notch/Sources`,
where `StageComposer` renders only a model label beside the send button. The
replica follows the source, because transcribing from source is the whole
method; the app is ahead of the vendored copy here.
