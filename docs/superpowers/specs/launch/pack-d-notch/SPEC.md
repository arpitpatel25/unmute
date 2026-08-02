# Pack D — Notch

**Branch:** `arpit/launch-notch`
**Owns:** `desktop/native-notch/**`
**Depends on:** nothing. Fully parallel — start immediately.
**Read first:** `../00-OVERVIEW.md`

Relevant existing files: `NotchGeometry.swift`, `NotchShape.swift`, `NotchWindow.swift`, `NotchView.swift`, `AppController.swift`, `Theme.swift`. `NotchGeometry.swift` and `AppController.swift` already reach for screen geometry — start there.

---

## 1. What is wrong today

In the unexpanded states the surface renders **below** the menubar, so on a MacBook's built-in display it sits underneath the physical cutout instead of level with it. The layout is decided once rather than per display, so connecting an external monitor does not change what it does. And there is no setting controlling whether the notch presents itself automatically.

## 2. The rule

**unmute lives in the menubar row.** Same height as the bar, sharing the notch's top edge. Nothing hangs below it in any unexpanded state, on any display.

### 2.1 One mass, not pieces
On a notched display the surface is a **single black shape that spans straight through the cutout** — left content, the cutout region, right content, drawn as one path.

This is not a detail. Two wings butted against the cutout can never look right: the cutout is rounded on *both* bottom corners, so anything placed beside it leaves a bitten-out curve exactly where the join must be invisible. Because the cutout is already black and the surface is black, drawing across it costs nothing and removes the join entirely.

Only the two **outer** bottom corners are rounded, matching the radius macOS uses for the cutout itself.

On a display without a notch: the same mass, centred, no reserved middle region.

### 2.2 Concave fillets
Where the mass meets the menubar, the black flares **outward** in a quarter-circle rather than stopping at a right angle. This inverted curve is what separates a surface that belongs to the screen from one pasted on top of it, and it matters most on expand where a hard vertical edge reads as a floating panel.

**The fillets belong to the shape path**, not to a separate overlay view. Fillets at a fixed size while the mass animates will visibly detach mid-motion — exactly when the eye is tracking it. Extend `NotchShape.swift`.

### 2.3 States

| State | Notched display | External | Notes |
|---|---|---|---|
| **Dormant** | nothing | nothing | An always-visible idle indicator stops being an indicator |
| **Idle** | left segment only — the wordmark | centred mass | One segment; there is no second thing to say |
| **Task** | left: count · right: current activity | one mass, both halves | |
| **Attention** | left: amber dot + "Needs you" · right: the question | one mass, amber | **The only state that glows.** If everything glows, nothing does |
| **Expanded** | drops below the bar | same | The one permitted exception — the user asked for it |

### 2.4 Per display, not per app
The layout is chosen from **the screen the surface is currently on**, and re-chosen when a display is connected, disconnected, or the surface moves between screens. This is the real engineering content; the layout rule itself is a few lines.

**Measure, never hardcode.** The cutout is a different width on 14" and 16" MacBooks and the bar height varies with scaling. macOS exposes the real geometry — the notched screen's safe-area inset and the usable areas either side of the cutout. Read those. A model-to-width lookup table breaks silently on the next MacBook.

## 3. Motion

The governing idea: **the mass never appears or disappears — it changes shape.** Nothing slides in. Nothing fades in as a panel.

- **One spring for every size change the surface ever makes.** Approximately `response 0.34`, `dampingFraction 0.82` — under-damped enough to settle, nowhere near bouncy. Put it in `Theme.swift` as a single named curve and use it everywhere. The moment two curves are in play the surface stops reading as one physical object.
- **Container morphs, content cross-fades, and they are offset.** Old content out fast (~90ms) *before* the shape finishes; container springs; new content in (~140ms, delayed ~80ms). Cross-fading in lockstep with the resize looks like two views swapping. Offsetting them looks like one thing becoming another.
- **Expand unfurls, collapse folds.** Expanding: width leads, height follows ~60ms behind. Collapsing runs strictly in reverse, height first. Asymmetry here makes the surface feel unreliable even when nobody can say why.
- Respect Reduce Motion: fall back to a short cross-fade with no spring.

## 4. Hover

**Hover reveals; click opens. Never hover-to-open.**

Hovering the collapsed mass grows it slightly and reveals one more level of detail — idle shows the task count, a running task shows its name. It does **not** open the panel. The menubar is somewhere the pointer passes through constantly; a panel that opens on approach becomes something the user fights. This is the main usability failure of NotchNook and its imitators.

## 5. Overflow

The mass has a maximum width bounded by the usable area beside the cutout. When content will not fit:

- the **right** segment truncates first, and if it cannot show something genuinely useful it is **dropped entirely rather than shown as an ellipsis**
- the **left** segment carries status only, is short by construction, and never truncates

A status indicator that can be cut off is not a status indicator.

## 6. Material — decision D5

**The bar-level mass is opaque black, always.** The `Fixed / Live glass / Follow system` setting governs the expanded panel and the recording pill **only**.

The mass impersonates the physical notch, and the physical notch is opaque. Any translucency breaks the illusion at precisely the join §2.1 removes. This also sidesteps the macOS 26.2 glass-caching bug for the one surface that could not tolerate it. `GlassLip.swift` and the glass path stay for the panel and pill.

## 7. Auto-present

A setting controls whether the notch presents itself automatically when a task needs attention or finishes. **Default on.** Pack B builds the control in Settings → Appearance & notch; this pack reads it and honours it. When off, state changes still update the mass in place — the surface simply never expands itself.

## 8. Constraints

- Do not touch anything outside `desktop/native-notch/`.
- The scratchpad's visual identity is settled and must not be altered: it is paper, it takes none of `Theme`'s colours, and it does not have a dark mode (`ScratchpadView.swift:3-17`). It may adopt the new motion curve.
- The Swift package must build.
- Existing IPC contracts in `IPC.swift` are unchanged unless a new field is genuinely required; if one is, note it — the engine side is not this pack's to edit.

## 9. Definition of done

On a MacBook's built-in display the surface is level with the notch and reads as the notch being wider, with no visible join. On an external display it is a centred mass in the menubar row. Plugging a monitor in re-lays it out. Nothing hangs below the bar unless expanded. Every size change uses one spring. Hover reveals without opening. The mass is opaque regardless of the surface setting.
