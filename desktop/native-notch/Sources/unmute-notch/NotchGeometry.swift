import AppKit

// Computes where the notch shell sits and how big it is in each state.
//
// Coordinates are AppKit screen coordinates (origin bottom-left). The shell
// hangs from the top-center of the active screen. On a hardware-notch Mac we
// straddle the physical notch; on a notch-less Mac we render a small dummy
// notch in the same spot — identical behavior, only the resting width differs.
struct NotchGeometry {
    let screenFrame: NSRect
    let hasNotch: Bool
    /// Width of the physical notch (menu-bar gap between the two safe areas),
    /// or the dummy-notch width when there is no hardware notch.
    let notchWidth: CGFloat
    let menuBarHeight: CGFloat

    static func current() -> NotchGeometry {
        let screen = NSScreen.main ?? NSScreen.screens.first!
        let frame = screen.frame

        // A hardware notch shows up as a non-zero top safe-area inset.
        let topInset = screen.safeAreaInsets.top
        let hasNotch = topInset > 0

        // auxiliaryTopLeftArea / auxiliaryTopRightArea bound the usable menu-bar
        // strips beside the notch; the gap between them is the notch width.
        var notchWidth: CGFloat = Self.dummyNotchWidth
        if hasNotch,
           let left = screen.auxiliaryTopLeftArea,
           let right = screen.auxiliaryTopRightArea {
            notchWidth = right.minX - left.maxX
            if notchWidth <= 0 { notchWidth = Self.dummyNotchWidth }
        }

        let menuBarHeight = hasNotch ? topInset : Self.dummyMenuBarHeight
        return NotchGeometry(screenFrame: frame, hasNotch: hasNotch,
                             notchWidth: notchWidth, menuBarHeight: menuBarHeight)
    }

    // Dummy-notch constants for Macs without a hardware notch: small and
    // unobtrusive, hugging the top-center.
    static let dummyNotchWidth: CGFloat = 180
    static let dummyMenuBarHeight: CGFloat = 24

    // Resting/expanded sizes. Width/height are the *content* footprint; the
    // window itself is sized to the largest state and the view morphs within.
    var idleSize: NSSize {
        // At idle we occupy roughly the notch itself (a touch wider so a glow
        // can bleed around the hardware cutout).
        NSSize(width: max(notchWidth + 12, 120), height: menuBarHeight)
    }
    var peekSize: NSSize { NSSize(width: 420, height: 72) }
    var panelSize: NSSize {
        // ~30–50% of the screen; height caps so it stays a panel, not a wall.
        let w = min(max(screenFrame.width * 0.42, 520), 900)
        let h = min(max(screenFrame.height * 0.42, 320), 560)
        return NSSize(width: w, height: h)
    }

    /// The window is sized to the largest state (panel) so morphs never need an
    /// OS-level resize; the SwiftUI content animates within this canvas.
    var windowFrame: NSRect {
        let size = panelSize
        let x = screenFrame.midX - size.width / 2
        // Hang from the very top of the screen.
        let y = screenFrame.maxY - size.height
        return NSRect(x: x, y: y, width: size.width, height: size.height)
    }
}
