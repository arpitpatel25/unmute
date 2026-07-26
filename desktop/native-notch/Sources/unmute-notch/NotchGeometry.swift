import AppKit

// Where the surface sits and how big it is in each state.
//
// AppKit screen coordinates (origin bottom-left). The surface is ALWAYS on the
// PRIMARY display (the one with the menu bar, frame.origin == 0,0) and pinned
// flush to that display's top edge — never hardcoded pixels, always relative to
// the screen frame, so plugging in an external monitor can't misplace it.
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

    static let dummyNotchWidth: CGFloat = 200
    static let dummyMenuBarHeight: CGFloat = 24

    // ── Per-state content sizes ──
    // Small rungs are notch-scale fixed sizes; task/cockpit are FRACTIONS of the
    // screen so they scale across displays (never hardcoded).

    /// Dormant: a barely-there sliver. On real-notch hardware it's invisible
    /// (drawn behind the physical notch); on non-notch it's the faint hint.
    var dormantSize: NSSize { NSSize(width: hasNotch ? notchWidth : 150, height: hasNotch ? menuBarHeight : 10) }
    /// Idle: matches the hardware notch; on a dummy notch it's a touch wider so
    /// the hover "unmute" label breathes.
    var idleSize: NSSize { NSSize(width: hasNotch ? notchWidth : 216, height: max(menuBarHeight, 34)) }
    /// Active/attention: a wider strip. On notched, flanks straddle the notch.
    var stripSize: NSSize { NSSize(width: hasNotch ? notchWidth + 160 : 300, height: max(menuBarHeight, 34)) }
    /// Task: a substantial surface — ~55% wide, height clamped so it stays a
    /// surface not a wall; the real height is content-measured (AppController).
    var taskSize: NSSize { taskSize(compact: false) }

    /// `compact` is for backends with NO TERMINAL (Codex desktop). The full
    /// height exists to give a live PTY room; a task whose panel shows a short
    /// conversation instead got the same 55% frame and rendered as a large black
    /// void with two buttons floating in it (field feedback 2026-07-25). The
    /// comment here used to claim the height was content-measured — it never
    /// was, so this at least stops sizing a conversation like a terminal.
    func taskSize(compact: Bool) -> NSSize {
        NSSize(width: round(min(max(screenFrame.width * 0.55, 560), 1100)),
               height: round(screenFrame.height * (compact ? 0.30 : 0.55)))
    }
    /// Cockpit: ~80% of the screen.
    var cockpitSize: NSSize {
        NSSize(width: round(screenFrame.width * 0.80), height: round(screenFrame.height * 0.80))
    }

    func size(for state: NotchState) -> NSSize {
        switch state {
        case .dormant:   return dormantSize
        case .idle:      return idleSize
        case .active, .attention: return stripSize
        case .task:      return taskSize
        case .cockpit:   return cockpitSize
        }
    }

    /// Center horizontally; pin the shape's TOP edge flush to the screen's top
    /// edge (frame.maxY). Square top corners + concave shoulders (NotchShape)
    /// then make it read as growing OUT of the notch rather than floating below.
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
}
