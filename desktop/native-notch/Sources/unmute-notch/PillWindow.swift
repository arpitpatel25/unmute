import AppKit
import SwiftUI

/// Reports the cluster's laid-out size so the window can be sized to fit it.
///
/// The window is CONTENT-SIZED rather than a wide canvas on purpose. A wide
/// transparent canvas would swallow clicks meant for the app underneath — the
/// legacy overlay needed a hover-driven click-through toggle for exactly this,
/// and that toggle was a recurring source of "the pill ate my click". With no
/// empty area there is nothing to pass through.
struct PillSizeKey: PreferenceKey {
    static var defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) {
        let n = nextValue()
        if n.width > 0 && n.height > 0 { value = n }
    }
}

/// The input surface's panel. Bottom-centre, non-activating, floats over
/// everything and never takes focus from the app the user is typing into —
/// which is the whole point of a dictation HUD.
final class PillWindow: NSPanel {

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 320, height: 44),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = .screenSaver
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false            // the material draws its own
        hidesOnDeactivate = false
        isMovableByWindowBackground = false
        // The pill hosts menus and buttons but never a text field, so it never
        // needs to become key. Staying non-key is what keeps the user's caret
        // exactly where it was while they dictate into another app.
        becomesKeyOnlyIfNeeded = true
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    func present() { orderFrontRegardless() }

    /// Bottom-centre of the PRIMARY display's visible frame (so it clears the
    /// Dock), sized to the cluster. Never animated on size: the pill must not
    /// appear to breathe while a chip's label re-flows mid-capture.
    func fit(_ size: CGSize, geometry: NotchGeometry) {
        let screen = NotchGeometry.primaryScreen()
        let visible = screen.visibleFrame
        let w = max(size.width, 120)
        let h = max(size.height, 44)
        let x = round(visible.midX - w / 2)
        let y = round(visible.minY + NotchGeometry.pillBottomInset)
        let frame = NSRect(x: x, y: y, width: w, height: h)
        guard frame != self.frame else { return }
        setFrame(frame, display: true)
    }
}

/// Wraps PillView and reports its size upward.
struct PillHost: View {
    @ObservedObject var model: PillModel

    var body: some View {
        PillView(model: model)
            .fixedSize()
            .background(
                GeometryReader { geo in
                    Color.clear.preference(key: PillSizeKey.self, value: geo.size)
                }
            )
    }
}
