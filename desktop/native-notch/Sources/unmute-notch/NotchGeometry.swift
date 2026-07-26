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
        let hasNotch = topInset > 0

        var notchWidth: CGFloat = Self.dummyNotchWidth
        if hasNotch,
           let left = screen.auxiliaryTopLeftArea,
           let right = screen.auxiliaryTopRightArea {
            let gap = right.minX - left.maxX
            if gap > 0 { notchWidth = gap }
        }

        let menuBarHeight = hasNotch ? topInset : Self.dummyMenuBarHeight
        return NotchGeometry(screenFrame: frame, hasNotch: hasNotch,
                             notchWidth: notchWidth, menuBarHeight: menuBarHeight)
    }

    static let dummyNotchWidth: CGFloat = 190
    static let dummyMenuBarHeight: CGFloat = 24

    // ── Per-state content sizes ──
    // Small rungs are notch-scale fixed sizes; task/cockpit are FRACTIONS of the
    // screen so they scale across displays (never hardcoded).

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

    /// Task: a substantial surface. Slightly shorter than it was — the content
    /// gutter dropped from 30pt to 16pt, so the same content needs less frame.
    var taskSize: NSSize { taskSize(compact: false) }

    /// `compact` is for backends with NO TERMINAL (Codex desktop). The full
    /// height exists to give a live PTY room; a task whose panel shows a short
    /// conversation instead got the same frame and rendered as a large void with
    /// two buttons floating in it (field feedback 2026-07-25).
    func taskSize(compact: Bool) -> NSSize {
        NSSize(width: round(min(max(screenFrame.width * 0.55, 560), 1100)),
               height: round(screenFrame.height * (compact ? 0.30 : 0.52)))
    }
    /// Cockpit: the survey surface.
    var cockpitSize: NSSize {
        NSSize(width: round(screenFrame.width * 0.78), height: round(screenFrame.height * 0.76))
    }

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

    /// Clamp a content-measured task height into a sane band (never a sliver,
    /// never taller than ~65% of the screen).
    func clampTaskHeight(_ h: CGFloat) -> CGFloat {
        min(max(h, screenFrame.height * 0.30), screenFrame.height * 0.65)
    }

    // ── The input surface (pill cluster) ──
    //
    // Bottom-centre = INPUT, top-centre = OUTPUT (spec 2026-07-24). The cluster
    // floats clear of the Dock rather than sitting on it, and is sized to its
    // content — the window is a canvas the cluster centres itself in, so chips
    // joining and leaving never move the pill.

    /// Height of the pill window canvas. Tall enough for the pill (44) plus the
    /// awareness card below it (36) plus breathing room.
    static let pillCanvasHeight: CGFloat = 132
    /// Distance from the bottom of the screen's visible frame.
    static let pillBottomInset: CGFloat = 26

    /// The pill window's frame — full usable width so the cluster can grow in
    /// both directions from centre without the window ever being resized
    /// mid-capture.
    func pillFrame() -> NSRect {
        let screen = Self.primaryScreen()
        let visible = screen.visibleFrame
        let width = min(screenFrame.width * 0.9, 1200)
        let x = round(screenFrame.midX - width / 2)
        let y = round(visible.minY + Self.pillBottomInset)
        return NSRect(x: x, y: y, width: width, height: Self.pillCanvasHeight)
    }
}
