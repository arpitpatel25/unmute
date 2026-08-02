import AppKit

// Where the surface sits and how big it is in each state.
//
// AppKit screen coordinates (origin bottom-left). The surface is ALWAYS on the
// PRIMARY display (the one with the menu bar, frame.origin == 0,0) and pinned
// flush to that display's top edge — never hardcoded pixels, always relative to
// the screen frame, so plugging in an external monitor can't misplace it.
//
// DISPLAY MATRIX (all resolved by the two rules above):
//   * No hardware notch anywhere      → dummy notch on the primary display
//   * Notched built-in is primary     → hugs the real notch; dormant is invisible
//   * Notched built-in, EXTERNAL is primary (menu bar moved) → renders on the
//     external with a dummy notch. This works only because the primary display
//     is resolved by origin == .zero rather than NSScreen.main, which follows
//     the CURSOR and would shuffle the surface between displays as the mouse
//     moved. Do not "simplify" primaryScreen().
//   * Clamshell                       → external is primary; dummy notch
//   * Hot-plug / rearrange            → didChangeScreenParametersNotification
//     re-runs current() (see AppController.observeScreens)
struct NotchGeometry {
    let screenFrame: NSRect
    let hasNotch: Bool
    /// Physical notch width when present; a dummy width otherwise.
    let notchWidth: CGFloat
    /// Menu-bar thickness (24pt plain, ~37pt notched).
    let menuBarHeight: CGFloat

    /// The primary display = the one whose frame origin is (0,0) (System
    /// Settings' "main display", where the menu bar lives). NSScreen.main is the
    /// *focused* screen and moves with the cursor — wrong for a menu-bar-anchored
    /// surface. This is the external-monitor fix.
    static func primaryScreen() -> NSScreen {
        NSScreen.screens.first(where: { $0.frame.origin == .zero })
            ?? NSScreen.main
            ?? NSScreen.screens[0]
    }

    static func current() -> NotchGeometry {
        let screen = primaryScreen()
        let frame = screen.frame

        let topInset = screen.safeAreaInsets.top
        // UNMUTE_FAKE_NOTCH=1 pretends this display has a hardware notch
        // (200pt wide, 37pt menu bar). Off by default and never set in the app.
        //
        // It exists because the notched layout is otherwise UNTESTABLE by anyone
        // without a notched Mac — which is how the old centred strip shipped
        // with its message inside the camera housing and nobody noticed. This is
        // the only way to look at that path on an external display or an M1 Air.
        let fake = ProcessInfo.processInfo.environment["UNMUTE_FAKE_NOTCH"] == "1"
        let hasNotch = fake || topInset > 0

        var notchWidth: CGFloat = fake ? 200 : Self.dummyNotchWidth
        if hasNotch,
           let left = screen.auxiliaryTopLeftArea,
           let right = screen.auxiliaryTopRightArea {
            let gap = right.minX - left.maxX
            if gap > 0 { notchWidth = gap }
        }

        let menuBarHeight = fake ? 37 : (hasNotch ? topInset : Self.dummyMenuBarHeight)
        return NotchGeometry(screenFrame: frame, hasNotch: hasNotch,
                             notchWidth: notchWidth, menuBarHeight: menuBarHeight)
    }

    // ── HARDWARE-NOTCH LAYOUT ──
    //
    // On a notched display nothing readable may sit BESIDE the cutout: there is
    // no screen there. The per-state widths below (+150 active, +220 attention)
    // grew the strip sideways and centred the text inside it — straight into the
    // camera housing, leaving two empty wings and no readable words.
    //
    // So on notched hardware the surface is the notch plus a TONGUE below it,
    // and its width follows the MESSAGE rather than the state. Notchless
    // displays keep the strip sizes exactly as they are: with no hole to avoid
    // they are already correct, and that is the only configuration in use today.

    /// Height of the tongue that carries a message below the notch.
    static let tongueHeight: CGFloat = 27

    /// Notched-display size. `contentWidth == nil` means no tongue at all —
    /// dormant, and idle until the pointer arrives. The tongue never goes
    /// narrower than the notch, or it reads as hanging off the hardware rather
    /// than growing out of it.
    func notchedSize(contentWidth: CGFloat?) -> NSSize {
        guard let cw = contentWidth else {
            return NSSize(width: notchWidth, height: menuBarHeight)
        }
        let w = min(max(cw + 30, notchWidth), screenFrame.width * 0.9)
        return NSSize(width: round(w), height: menuBarHeight + Self.tongueHeight)
    }

    static let dummyNotchWidth: CGFloat = 190
    static let dummyMenuBarHeight: CGFloat = 24

    // ── Per-state content sizes ──
    // Small rungs are notch-scale fixed sizes — they hug the notch, so they are
    // sized in notch units and nothing else.
    //
    // The EXPANDED surfaces (task, cockpit) are pure FRACTIONS of the screen, on
    // both axes, with no floor and no ceiling. A fraction that is then clamped to
    // a pixel range is not a fraction: the old task width was
    // `min(max(W*0.55, 560), 1100)`, so on any display wider than 2000pt the cap
    // decided the size and the surface got proportionally SMALLER the bigger the
    // monitor — 43% of a 2560-wide external, 55% of a laptop. Share of screen is
    // the whole contract; see SurfaceFill.

    /// Dormant.
    ///
    /// On real-notch hardware this is EXACTLY the notch: drawn behind it, so at
    /// rest unmute costs zero pixels and the hardware never looks broken.
    ///
    /// On a notch-less display it is a slim capsule. It cannot be nothing —
    /// field feedback recorded that a fully invisible dummy notch was
    /// unfindable — but 9pt is barely over half the old 10pt tab's presence and
    /// reads as a hairline rather than a black flag hanging into content.
    var dormantSize: NSSize {
        NSSize(width: hasNotch ? notchWidth : 190,
               height: hasNotch ? menuBarHeight : 9)
    }
    /// Idle: matches the hardware notch; on a dummy notch a touch wider so the
    /// "unmute" label breathes.
    var idleSize: NSSize {
        NSSize(width: hasNotch ? notchWidth : 230, height: max(menuBarHeight, 34))
    }
    /// Active: a wider strip carrying the breathing dot, the count and elapsed.
    var activeSize: NSSize {
        NSSize(width: hasNotch ? notchWidth + 150 : 330, height: max(menuBarHeight, 36))
    }
    /// Attention: wider still — it carries a headline, so it needs the measure.
    var attentionSize: NSSize {
        NSSize(width: hasNotch ? notchWidth + 220 : 400, height: max(menuBarHeight, 40))
    }
    /// Kept for callers that don't distinguish the two strip states.
    var stripSize: NSSize { activeSize }

    /// How much of the screen an expanded surface fills, by what it carries.
    ///
    /// These are the whole sizing policy for task and cockpit, in one place and
    /// stated as shares rather than pixels. Same share on a 13" laptop as on a
    /// 32" external — the surface looks like the same object on both.
    enum SurfaceFill {
        /// A task on a backend with NO PTY (Codex desktop, Claude Code desktop).
        /// Its panel is a conversation and a composer: readable at a smaller
        /// measure, and a full-size frame around it renders as a large void with
        /// two buttons floating in it (field feedback 2026-07-25).
        static let desktopTask: CGFloat = 0.60
        /// A terminal-backed task — Claude's PTY, the Codex CLI, anything with
        /// live scrollback. The terminal IS the content here, and it was being
        /// given a half-screen panel: 80 columns of output in a 792pt window is
        /// the size complaint this whole change answers.
        static let terminalTask: CGFloat = 0.80
        /// The cockpit, always. Whatever is on the wall, expanding it is a
        /// deliberate "show me everything" and it gets the room to be that.
        static let cockpit: CGFloat = 0.80
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

    func size(for state: NotchState) -> NSSize {
        switch state {
        case .dormant:   return dormantSize
        case .idle:      return idleSize
        case .active:    return activeSize
        case .attention: return attentionSize
        case .task:      return taskSize
        case .cockpit:   return cockpitSize
        }
    }

    /// Center horizontally; pin the shape's TOP edge flush to the screen's top
    /// edge (frame.maxY). Square top corners then make it read as growing OUT of
    /// the notch rather than floating below it.
    func topPinnedFrame(width: CGFloat, height: CGFloat) -> NSRect {
        let x = round(screenFrame.midX - width / 2)
        let y = round(screenFrame.maxY - height)
        return NSRect(x: x, y: y, width: width, height: height)
    }

    func windowFrame(for state: NotchState) -> NSRect {
        let size = size(for: state)
        return topPinnedFrame(width: size.width, height: size.height)
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
    /// It was 90% of the screen capped at 1200. The scratchpad is now drawn
    /// inside this same canvas as one more element in the cluster's row, and the
    /// row carries a counterweight of the pad's width on the far side so the
    /// pill stays put (PillView.counterweight) — which means the canvas must
    /// hold `2 × 340 + 2 × 8 + the widest column`. With the Codex selector open
    /// that is ~1226, and the old cap clipped it. Nothing is drawn in the extra
    /// width, and the empty area stays click-through (see PillWindow), so the
    /// cap bought nothing and cost the pad its edge.
    ///
    /// A display narrower than ~1226pt still cannot show that widest case whole;
    /// the pad's outer edge is clipped and the pill stays where it is, which is
    /// the right way round. The ordinary dictation cluster needs only ~908.
    func pillFrame() -> NSRect {
        let screen = Self.primaryScreen()
        let visible = screen.visibleFrame
        let width = screenFrame.width
        let x = round(screenFrame.minX)
        let y = round(visible.minY + Self.pillBottomInset)
        return NSRect(x: x, y: y, width: width, height: Self.pillCanvasHeight)
    }
}
