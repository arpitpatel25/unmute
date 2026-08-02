# Pack D — verification

**You did not write this code.** Disprove that it is finished. PASS / FAIL / ESCALATE with evidence. Do not fix anything.

This pack is unusually visual. Many assertions are `[eye]` by nature — do not guess at them, and do not accept the implementer's screenshots as proof of the ones that require a real MacBook display.

Paths relative to `desktop/native-notch/Sources/unmute-notch/`.

---

## A. It builds

1. `[auto]` `cd desktop/native-notch && swift build` → exit 0
2. `[auto]` No warnings introduced that were not on `origin/main`.

## B. Vertical position — the core fix

3. `[auto]` The unexpanded surface is positioned at the top of the screen frame, not below the menubar. Find the origin calculation in `NotchWindow.swift` / `NotchGeometry.swift` and show it resolves to the screen's top edge.
4. `[auto]` The unexpanded surface height equals the menubar height, read from the system — not a literal.
5. `[eye]` **On a MacBook with a physical notch:** in dormant, idle, task and attention, nothing renders below the menubar. This is the bug being fixed; it is the single most important check in this document.
6. `[eye]` On an external display: the mass sits in the menubar row, not hanging below it.
7. `[eye]` Expanded is the only state that occupies space below the bar.

## C. One mass, no join

8. `[auto]` The shape is drawn as a single path spanning the cutout region — not two views placed either side. Read `NotchShape.swift`; two separately-positioned subviews flanking the cutout is a **FAIL**.
9. `[auto]` Only the outer bottom corners carry a radius; the region crossing the cutout has none.
10. `[eye]` **Zoom in on the junction.** There is no seam, no gap, no bitten-out curve, and no colour difference between the mass and the physical cutout. Any visible discontinuity is a FAIL.
11. `[eye]` The mass reads as the notch being wider — not as a pill parked beside a notch.

## D. Fillets

12. `[auto]` Concave corners are part of the shape path, not a separate overlay view or image.
13. `[eye]` At both outer ends the black flares outward into the menubar with a quarter-circle curve.
14. `[eye]` **During a size animation the fillets stay attached** and scale with the mass. Fillets that lag, jump or detach mid-spring are a FAIL — this is the specific failure a fixed-size overlay produces.
15. `[eye]` The expanded panel carries the same fillets at its top corners.

## E. Per-display

16. `[auto]` Layout reads the current screen's geometry, re-evaluated rather than computed once at launch.
17. `[auto]` **No hardcoded cutout width.** `grep -rn "notchWidth\|= 180\|= 168\|= 200" *.swift` → any literal standing in for cutout width is a FAIL. It must come from the system.
18. `[auto]` A display-change notification is observed.
    `grep -rn "didChangeScreenParameters\|screenParameters\|NSApplication.didChangeScreen" *.swift` → **at least one match**
19. `[eye]` Plug in an external monitor while running: layout re-evaluates without a restart.
20. `[eye]` Unplug it: layout returns correctly.
21. `[eye]` Move the surface between screens: it adopts the right layout for the screen it is on.
22. `[eye]` On a Mac with **no** built-in notch at all (external only), the centred layout is used and nothing assumes a cutout exists.

## F. States

23. `[auto]` All five states exist in the model.
24. `[eye]` Dormant renders nothing at all.
25. `[eye]` Idle renders one segment only.
26. `[eye]` Task shows a count and current activity.
27. `[eye]` Attention is amber and glows.
28. `[auto]` **Only attention glows.** `grep -rn "shadow\|glow" *.swift` — confirm no other state applies one. Multiple glowing states is a FAIL.

## G. Motion

29. `[auto]` **One spring, named once.** A single animation curve is defined in `Theme.swift` and used for every size change. `grep -rn "\.spring(\|animation(" *.swift` — list every call; any that uses a different response/damping for a size change is a FAIL.
30. `[auto]` Response ≈ 0.34 and damping ≈ 0.82.
31. `[auto]` Content cross-fade is offset from the container animation, not simultaneous — find the delay.
32. `[auto]` Expand and collapse are ordered inversely (width-then-height vs height-then-width).
33. `[eye]` The mass visibly *morphs* between states. Anything that fades out and fades in as a new object is a FAIL.
34. `[eye]` Expand and collapse feel symmetrical.
35. `[auto]` Reduce Motion is honoured.
    `grep -rn "reduceMotion\|accessibilityReduceMotion" *.swift` → **at least one match**
36. `[eye]` With Reduce Motion on, there is no spring and nothing is broken.

## H. Hover

37. `[auto]` A hover handler exists on the collapsed mass.
38. `[eye]` Hovering reveals more detail and grows the mass slightly.
39. `[eye]` **Hovering does NOT open the panel.** This is an explicit design decision — hover-to-open is a FAIL.
40. `[eye]` Moving the pointer across the menubar to reach a menu extra does not trigger anything disruptive.

## I. Overflow

41. `[auto]` A maximum width bounded by the usable area beside the cutout is enforced.
42. `[auto]` The right segment truncates or is dropped; the left never truncates.
43. `[eye]` With a very long task name the right segment degrades gracefully and the status stays fully readable.
44. `[eye]` With many menu extras installed the mass does not overlap them or get clipped.

## J. Material — decision D5

45. `[auto]` The bar-level mass uses an opaque colour, never a glass/blur material.
    Read the mass's background; any `NSVisualEffectView` / `.ultraThinMaterial` on it is a **FAIL**.
46. `[auto]` The surface-appearance setting is still applied to the expanded panel and the pill.
47. `[eye]` Switching Fixed / Live glass / Follow system changes the panel and pill, and leaves the mass unchanged.

## K. Auto-present

48. `[auto]` The auto-present setting is read.
49. `[eye]` On (default): the notch presents itself when a task needs attention.
50. `[eye]` Off: it never expands itself, but state still updates in place.
51. `[auto]` The default is **on** when the setting is absent.

## L. Scratchpad untouched

52. `[auto]` `ScratchpadView.swift`'s literal colours are unchanged.
    `git diff origin/main...HEAD -- ScratchpadView.swift` → colour literals must not appear in the diff
53. `[eye]` The pad still looks like paper in both light and dark appearance.
54. `[auto]` The pad may adopt the new motion curve, but must not adopt `Theme`'s colours.

## M. Boundaries — FAILs

55. `[auto]` `git diff --name-only origin/main...HEAD` contains only paths under `desktop/native-notch/`. **Anything else is a FAIL.**
56. `[auto]` No renderer or Electron file changed.
57. `[auto]` If `IPC.swift`'s wire format changed, that is an ESCALATE — the engine side is not this pack's to edit and the change must be coordinated.

## N. Where this most plausibly broke something else

58. `[eye]` **The pill.** `PillWindow.swift` shares geometry helpers with the notch. Confirm the recording pill still appears in the right place, in both Top center and Top right positions.
59. `[eye]` The wall / task surface still opens from the notch and fills correctly — `WallView` and `TaskSurfaceView` sit inside the expanded shape whose path just changed.
60. `[eye]` The terminal host still renders at the right size. `providerOf().hasTerminal` drives an 80% vs 60% surface share; a changed shape path may have broken that ratio.
61. `[eye]` Multi-Space behaviour: move to another Space and back. The surface must not be left on the wrong screen or drawn at the old geometry.
62. `[eye]` Display scaling: test at a non-default resolution. A hardcoded bar height will show up here.
