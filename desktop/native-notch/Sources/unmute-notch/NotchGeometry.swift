import AppKit
import SurfaceSizeSupport

// WHERE THE SURFACE SITS, MEASURED FROM ONE SCREEN.
//
// AppKit screen coordinates (origin bottom-left). Two rules decide everything:
//
//   1. UNMUTE LIVES IN THE MENUBAR ROW. Unexpanded, the mass is exactly as tall
//      as the menu bar and shares the notch's top edge. Nothing hangs below the
//      bar in any resting state, on any display. Only the expanded panel drops
//      below it, which is the one exception the user asked for.
//
//   2. EVERYTHING IS MEASURED, NEVER HARDCODED. The cutout is a different width
//      on a 14" and a 16" MacBook and the bar height moves with display
//      scaling. macOS reports both — safeAreaInsets, auxiliaryTopLeftArea /
//      auxiliaryTopRightArea, visibleFrame. A model-to-width lookup table would
//      break silently on the next machine Apple ships.
//
// DISPLAY MATRIX (all resolved by the two rules above):
//   * No hardware notch anywhere      → centred mass, no reserved middle
//   * Notched built-in is primary     → mass spans THROUGH the cutout
//   * Notched built-in, EXTERNAL is primary (menu bar moved) → renders on the
//     external, centred. This works only because the primary display is
//     resolved by origin == .zero rather than NSScreen.main, which follows the
//     CURSOR and would shuffle the surface between displays as the mouse moved.
//     Do not "simplify" primaryScreen().
//   * Clamshell                       → external is primary; centred
//   * Hot-plug / rearrange / scaling  → didChangeScreenParametersNotification
//     re-runs current() (see AppController.observeScreens). The layout is
//     re-chosen from the screen the surface is on, never cached from launch.
struct NotchGeometry: Equatable {
    let screenFrame: NSRect
    let hasNotch: Bool
    /// The physical cutout, in SCREEN coordinates. nil on a display without one.
    /// Its width and position come from the OS; nothing here invents them.
    let cutout: NSRect?
    /// Menu-bar thickness, measured. On a notched display this is the safe-area
    /// inset, which is also the height of the housing — which is why the mass
    /// and the cutout share a bottom edge for free.
    let barHeight: CGFloat
    /// Usable width to the left / right of the cutout — the real estate the
    /// mass may spend. Half the screen each when there is no cutout.
    let leftUsable: CGFloat
    let rightUsable: CGFloat

    // MARK: - Measuring

    /// The primary display = the one whose frame origin is (0,0) (System
    /// Settings' "main display", where the menu bar lives). NSScreen.main is the
    /// *focused* screen and moves with the cursor — wrong for a menu-bar-anchored
    /// surface. This is the external-monitor fix.
    static func primaryScreen() -> NSScreen {
        NSScreen.screens.first(where: { $0.frame.origin == .zero })
            ?? NSScreen.main
            ?? NSScreen.screens[0]
    }

    /// The screen the SURFACE is actually on.
    ///
    /// The layout is a property of that screen, not of the app: a notched
    /// built-in and an external monitor want different shapes, and which one we
    /// are on can change under us (hot-plug, "main display" moved in System
    /// Settings, the window dragged by the window server during a Space swipe).
    /// Falls back to the primary display, which is where a menu-bar surface
    /// belongs when the question has no other answer.
    static func screen(hosting window: NSWindow?) -> NSScreen {
        guard let window, let s = window.screen else { return primaryScreen() }
        // Only honour it if that screen actually carries a menu bar row we can
        // live in — i.e. it is the primary one. Anything else and the surface
        // would sit in the middle of a monitor with no bar to be level with.
        return s.frame.origin == .zero ? s : primaryScreen()
    }

    /// LAST-DITCH ONLY, and never used when macOS answers.
    ///
    /// Reachable in exactly two situations: the UNMUTE_FAKE_NOTCH test harness,
    /// and a display that reports a top safe-area inset but refuses to report
    /// the auxiliary areas either side of it (never observed; the API has
    /// returned them on every notched Mac since Monterey). It is a FRACTION of
    /// the screen rather than a pixel count so that it degrades sensibly rather
    /// than being wrong by a fixed amount on every future machine — a 14" MBP
    /// cutout is ~13% of its width.
    static let estimatedCutoutFraction: CGFloat = 0.13

    /// Concave fillet and outer bottom radius, as fractions of the measured bar.
    ///
    /// macOS exposes no API for the cutout's own corner radius, so it is derived
    /// from the one number it does expose. At a 37pt notched bar this lands at
    /// 11pt, which is the radius the housing reads as; at a 24pt plain bar it
    /// scales down to 7pt with it rather than looking bolted on.
    static let filletOfBar: CGFloat = 0.30
    static let cornerOfBar: CGFloat = 0.30

    static func current(for screen: NSScreen = primaryScreen()) -> NotchGeometry {
        let frame = screen.frame
        let inset = screen.safeAreaInsets.top

        // UNMUTE_FAKE_NOTCH=1 pretends this display has a hardware cutout. Off
        // by default and never set in the app.
        //
        // It exists because the notched layout is otherwise UNTESTABLE by anyone
        // without a notched Mac — which is how the old centred strip shipped
        // with its message inside the camera housing and nobody noticed. Note
        // that it fakes only the CUTOUT: the bar height stays the real measured
        // one, because a simulation that also lied about the bar would hide the
        // very bug this pack exists to fix.
        // Accepts "1" for a rough guess, or "WxH" in points for a specific
        // machine — UNMUTE_FAKE_NOTCH=200x34 is a 14" Pro, 168x32 an Air 13".
        //
        // The sizes MATTER and "1" alone was not enough. It derived the width
        // from a screen fraction and took the HEIGHT from the local menu bar —
        // about 24pt on a notchless Mac against a real cutout's ~34. Height is
        // the dimension that ate the pocket's title row, so the one simulation
        // we had under-tested the exact fault it existed to catch, and could
        // not tell a 16" from an Air either way.
        let fake = ProcessInfo.processInfo.environment["UNMUTE_FAKE_NOTCH"] ?? ""
        let simulate = !fake.isEmpty && fake != "0"
        var fakeSize: CGSize? = nil
        if simulate {
            let parts = fake.lowercased().split(separator: "x")
            if parts.count == 2, let w = Double(parts[0]), let h = Double(parts[1]), w > 0, h > 0 {
                fakeSize = CGSize(width: w, height: h)
            }
        }
        let real = inset > 0

        // MEASURED, in preference order:
        //   1. the notched display's safe-area inset (== the housing's height)
        //   2. frame.maxY − visibleFrame.maxY — the menu bar, exactly, at
        //      whatever scaling the user is running
        //   3. the status bar's own thickness, for an auto-hidden menu bar,
        //      where (2) measures zero
        let measured = frame.maxY - screen.visibleFrame.maxY
        let barHeight = real ? inset
                             : (measured > 0 ? measured : NSStatusBar.system.thickness)

        var cutout: NSRect? = nil
        var leftUsable = frame.width / 2
        var rightUsable = frame.width / 2

        if real, let l = screen.auxiliaryTopLeftArea, let r = screen.auxiliaryTopRightArea,
           r.minX > l.maxX {
            // THE REAL THING: the OS tells us exactly where the hole is and how
            // much bar there is either side of it.
            cutout = NSRect(x: l.maxX, y: frame.maxY - barHeight,
                            width: r.minX - l.maxX, height: barHeight)
            leftUsable = l.width
            rightUsable = r.width
        } else if real || simulate {
            let w = fakeSize?.width ?? round(frame.width * Self.estimatedCutoutFraction)
            // A simulated cutout may be TALLER than the local menu bar, which is
            // the whole point: that is what a real notch is, and it is what the
            // surfaces have to clear.
            let h = fakeSize?.height ?? barHeight
            cutout = NSRect(x: round(frame.midX - w / 2), y: frame.maxY - h,
                            width: w, height: h)
            leftUsable = (frame.width - w) / 2
            rightUsable = leftUsable
            if simulate { NotchLog.log("cutout SIMULATED w=\(Int(w)) h=\(Int(h)) — UNMUTE_FAKE_NOTCH") }
            // Logged only for the case that should never happen. The test
            // harness takes this branch on every measurement and would otherwise
            // fill the log with a line per state change.
            if real { NotchLog.log("cutout ESTIMATED — this display reports an inset but no auxiliary areas: w=\(Int(w))") }
        }

        return NotchGeometry(screenFrame: frame,
                             hasNotch: cutout != nil,
                             cutout: cutout,
                             barHeight: barHeight,
                             leftUsable: leftUsable,
                             rightUsable: rightUsable)
    }

    // MARK: - Derived shape numbers

    var cutoutWidth: CGFloat { cutout?.width ?? 0 }
    /// How far down a large surface must start to clear the housing. The real
    /// cutout's height, which is NOT always the bar height — a simulated one can
    /// be taller, and on some displays the two genuinely differ.
    var cutoutHeight: CGFloat { cutout?.height ?? barHeight }
    /// The x the mass's middle is anchored on: the hole, or the screen's centre
    /// when there is none.
    var anchorX: CGFloat { cutout?.midX ?? screenFrame.midX }
    /// Concave fillet at bar level, derived from the measured bar.
    var barFillet: CGFloat { max(round(barHeight * Self.filletOfBar), 4) }
    /// Outer bottom radius at bar level — the cutout's own, as near as macOS
    /// lets us get.
    var barCornerRadius: CGFloat { max(round(barHeight * Self.cornerOfBar), 4) }

    // MARK: - The bar-level mass

    /// Gap between the two halves when there is no cutout to separate them.
    static let segmentGap: CGFloat = 18
    /// Below this a right-hand segment cannot say anything genuinely useful, so
    /// it is DROPPED rather than shown as an ellipsis. A status line that can be
    /// cut off is not a status line.
    static let minRightSegment: CGFloat = 54
    /// Breathing room kept between the mass and the far edge of the bar, so the
    /// mass can never collide with the clock or the leftmost app menu.
    static let barEdgeKeepOut: CGFloat = 24

    /// The mass, resolved: how wide each half is allowed to be, what sits
    /// between them, and the shape numbers that go with it.
    ///
    /// OVERFLOW POLICY, in one place:
    ///   * the RIGHT segment truncates first, and is dropped entirely below
    ///     `minRightSegment`
    ///   * the LEFT segment carries status only, is short by construction, and
    ///     is never truncated — it is the thing that must stay readable
    func mass(left: CGFloat, right: CGFloat) -> MassPlacement {
        let fillet = barFillet
        let roomRight = max(rightUsable - fillet - Self.barEdgeKeepOut, 0)
        var r = min(right, roomRight)
        if r < Self.minRightSegment { r = 0 }
        // The left half is not cut down — but if it ever outgrows the bar beside
        // the cutout, `barFrame` will slide the whole mass off the hole to keep
        // it on screen and the join will open up. That is a content bug (the
        // left half carries the wordmark, a count or a status word, all short by
        // construction), and this is the line that makes it visible instead of
        // mysterious.
        if left > max(leftUsable - fillet - Self.barEdgeKeepOut, 0) {
            NotchLog.log("LEFT SEGMENT OVERFLOWS the bar beside the cutout: want=\(Int(left)) room=\(Int(leftUsable)) — the mass will be pushed off the cutout anchor")
        }
        let middle = cutoutWidth > 0 ? cutoutWidth
                                     : (left > 0 && r > 0 ? Self.segmentGap : 0)
        return MassPlacement(left: left, middle: middle, right: r,
                             fillet: fillet, bottomRadius: barCornerRadius)
    }

    /// THE POCKET, OPEN — the same mass rules, with one difference.
    ///
    /// The right half here is not a status line that can be dropped: it carries
    /// the close button, and a card you cannot dismiss is not a card. So both
    /// halves are clamped to the room beside the cutout and neither is ever
    /// removed. Everything else — the fillets, the anchor, the middle being the
    /// hole itself — is exactly `mass`.
    func pocketMass(left: CGFloat, right: CGFloat) -> MassPlacement {
        let fillet = barFillet
        let l = min(left, max(leftUsable - fillet - Self.barEdgeKeepOut, 0))
        let r = min(right, max(rightUsable - fillet - Self.barEdgeKeepOut, 0))
        return MassPlacement(left: ceil(l), middle: cutoutWidth, right: ceil(r),
                             fillet: fillet, bottomRadius: barCornerRadius)
    }

    /// THE POCKET, OFF THE NOTCH. One card, always this size.
    ///
    /// There is no housing to work around here, so the card keeps its own shape
    /// and hangs from the top edge on the ordinary panel padding. It is the
    /// FULLER card, not the old 64pt compact one: nothing off-notch forces the
    /// content onto a single line, so a card showing only a title and a status
    /// word would be withholding rather than compact.
    static let pocketCardWidth: CGFloat = 348
    /// who · what it is asking · which of them (see PocketCard).
    ///
    /// TWO HEIGHTS, because the middle row is only drawn when there is something
    /// to ask. It used to be one — 106pt, sized for a two-line question — and a
    /// task with no question filled that row with the same status word the footer
    /// shows, so the card said "Done" twice and spent a third of itself doing it.
    /// The arithmetic lives in SurfaceSizeSupport beside its tests, so the window
    /// frame and the view cannot drift apart.
    func pocketCardFrame(hasAsk: Bool) -> NSRect {
        topPinnedFrame(width: Self.pocketCardWidth,
                       height: pocketCardHeight(hasAsk: hasAsk) + 2 * Theme.panelPadding)
    }

    /// The window frame for a bar-level mass.
    ///
    /// ANCHORED ON THE HOLE, not on the screen: the mass's middle must sit
    /// exactly over the cutout or the whole illusion collapses. With no cutout
    /// there is nothing to align to and the mass centres instead.
    func barFrame(_ m: MassPlacement) -> NSRect {
        let w = min(m.width, screenFrame.width)
        var x: CGFloat
        if cutout != nil {
            x = anchorX - m.middle / 2 - m.left - m.fillet
        } else {
            x = screenFrame.midX - w / 2
        }
        x = min(max(x, screenFrame.minX), screenFrame.maxX - w)
        return NSRect(x: round(x), y: round(screenFrame.maxY - barHeight),
                      width: round(w), height: round(barHeight))
    }

    /// Dormant is INVISIBLE — an always-visible idle indicator stops being an
    /// indicator.
    ///
    /// On a notched display the window is the cutout itself, inset by a point so
    /// no black can spill past the hardware's rounded corners. Nothing new is
    /// drawn — those pixels are not displayed — but the pointer can still find
    /// the surface there, which is the gesture people already know.
    ///
    /// On a display with NO cutout there is nowhere to hide, so dormant reserves
    /// nothing and draws nothing at all.
    func dormantFrame() -> NSRect {
        let y = round(screenFrame.maxY - barHeight)
        guard let c = cutout, c.width > 4 else {
            return NSRect(x: round(screenFrame.midX - 1), y: y, width: 2, height: round(barHeight))
        }
        return NSRect(x: round(c.minX + 1), y: y,
                      width: round(c.width - 2), height: round(barHeight))
    }

    // MARK: - Expanded surfaces
    //
    // The EXPANDED surfaces (task, cockpit) are pure FRACTIONS of the screen, on
    // both axes, with no floor and no ceiling. A fraction that is then clamped to
    // a pixel range is not a fraction: the old task width was
    // `min(max(W*0.55, 560), 1100)`, so on any display wider than 2000pt the cap
    // decided the size and the surface got proportionally SMALLER the bigger the
    // monitor — 43% of a 2560-wide external, 55% of a laptop. Share of screen is
    // the whole contract; see SurfaceFill.

    /// How much of the screen an expanded surface fills, by what it carries.
    enum SurfaceFill {
        /// The user's choice, from Settings → Appearance & notch: 0.7 | 0.8 | 0.9.
        /// This is an absolute screen fraction for every expanded surface.
        static var user: CGFloat = 0.80

        static var desktopTask: CGFloat { user }
        /// A terminal-backed task — Claude's PTY, the Codex CLI, anything with
        /// live scrollback. The terminal IS the content here, and it was being
        /// given a half-screen panel: 80 columns of output in a 792pt window is
        /// the size complaint this whole change answers.
        static var terminalTask: CGFloat { user }
        /// The cockpit, always. Whatever is on the wall, expanding it is a
        /// deliberate "show me everything" and it gets the room to be that.
        static var cockpit: CGFloat { user }
    }

    /// An expanded surface at `fill` of the screen, on BOTH axes.
    func expandedSize(fill: CGFloat) -> NSSize {
        NSSize(width: round(screenFrame.width * fill),
               height: round(screenFrame.height * fill))
    }

    /// Task, sized to what its backend needs. `terminal: false` is the
    /// desktop-app case (see TaskDetail.hasTerminal — the one place that rule
    /// is decided).
    func taskSize(terminal: Bool) -> NSSize {
        expandedSize(fill: terminal ? SurfaceFill.terminalTask : SurfaceFill.desktopTask)
    }
    /// Task, for callers with no task in hand. A PTY is the default backend, so
    /// the terminal size is the honest default.
    var taskSize: NSSize { taskSize(terminal: true) }

    /// Cockpit: the survey surface.
    var cockpitSize: NSSize { expandedSize(fill: SurfaceFill.cockpit) }

    /// Centre horizontally; pin the shape's TOP edge flush to the screen's top
    /// edge (frame.maxY). The expanded panel is the ONE surface allowed to
    /// occupy space below the bar.
    func topPinnedFrame(width: CGFloat, height: CGFloat) -> NSRect {
        let x = round(screenFrame.midX - width / 2)
        let y = round(screenFrame.maxY - height)
        return NSRect(x: x, y: y, width: width, height: height)
    }

    /// The expanded panel's own shape numbers. Same path, same fillets — a
    /// panel with square shoulders reads as a floating window pasted over the
    /// screen instead of something the screen grew.
    var panelPlacement: MassPlacement {
        MassPlacement(left: 0, middle: 0, right: 0,
                      fillet: Theme.panelFillet, bottomRadius: Theme.panelRadius)
    }

    // NO clampTaskHeight. It described a content-MEASURED task height clamped to
    // a 30–65% band, from a design where the panel sized itself to its content.
    // Nothing has called it since the task surface became a fixed share of the
    // screen, and leaving a second, contradictory size contract lying next to
    // SurfaceFill is how the two drift apart.

    // ── The input surface (pill cluster) ──
    //
    // Bottom-centre = INPUT, top-centre = OUTPUT (spec 2026-07-24). The cluster
    // floats clear of the Dock rather than sitting on it, and is sized to its
    // content — the window is a canvas the cluster centres itself in, so chips
    // joining and leaving never move the pill.

    /// Height of the pill window canvas.
    ///
    /// Must clear the TALLEST thing that can appear above the cluster — the
    /// model selector, which is four columns of up to ~5 rows plus a summary
    /// line (~230pt) — as well as the coaching chip and the awareness card. At
    /// 132 the panel opened into a window too short to show it and was simply
    /// clipped away; nothing is drawn outside the cluster, so an oversized
    /// canvas costs nothing (see PillWindow: empty area stays click-through).
    static let pillCanvasHeight: CGFloat = 400
    /// Distance from the bottom of the screen's visible frame.
    static let pillBottomInset: CGFloat = 26

    /// The pill window's frame — the WHOLE screen width, so the cluster can grow
    /// in both directions from centre without the window ever being resized
    /// mid-capture.
    ///
    /// A display narrower than ~1226pt cannot show the widest case whole; the
    /// pad's outer edge is clipped and the pill stays where it is, which is the
    /// right way round. The ordinary dictation cluster needs only ~908.
    func pillFrame() -> NSRect {
        let visible = Self.primaryScreen().visibleFrame
        let width = screenFrame.width
        let x = round(screenFrame.minX)
        let y = round(visible.minY + Self.pillBottomInset)
        return NSRect(x: x, y: y, width: width, height: Self.pillCanvasHeight)
    }
}

/// THE MASS, RESOLVED — the numbers the window frame, the shape and the content
/// row are all built from, so none of them can disagree with the others.
///
/// `middle` is the cutout on a notched display and a plain gap on one without;
/// nothing else in the app needs to know which, because the mass is drawn
/// straight through either way.
struct MassPlacement: Equatable {
    var left: CGFloat = 0
    var middle: CGFloat = 0
    var right: CGFloat = 0
    /// Concave flare at each outer end. Part of the shape path (NotchShape),
    /// which is why it is included in the window's width and in the content's
    /// horizontal padding.
    var fillet: CGFloat = 0
    var bottomRadius: CGFloat = 0

    var width: CGFloat { fillet + left + middle + right + fillet }

    static let empty = MassPlacement()
}
