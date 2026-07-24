import AppKit

// The floating notch panel. It is a non-activating NSPanel so clicking it never
// pulls focus from the user's foreground app (the same discipline overlay.ts
// used: screen-saver level, joins all Spaces, ordered front without becoming
// key). The window canvas is the largest (panel) size; the SwiftUI content
// morphs inside it, top-anchored under the notch.
final class NotchWindow: NSPanel {

    init(geometry: NotchGeometry) {
        super.init(
            contentRect: geometry.windowFrame(for: .idle),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        isFloatingPanel = true
        level = .screenSaver               // above normal windows, cross-Space
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false                  // the shape draws its own shadow
        hidesOnDeactivate = false
        isMovableByWindowBackground = false

        // Never take key/main — that would steal focus.
        // (NSPanel.nonactivating already prevents activation; these make it explicit.)
    }

    // A borderless panel returns false for these by default; keep it explicit so
    // a future style-mask change can't silently start grabbing focus.
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// Show without activating the app or stealing focus.
    func present() {
        orderFrontRegardless()
    }

    /// Resize + reposition to an explicit top-pinned frame, spring-eased so the
    /// morph reads as "live"; SwiftUI animates its corner radius / contents in
    /// lockstep.
    func applyFrame(_ frame: NSRect, animated: Bool) {
        guard animated else { setFrame(frame, display: true); return }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.34
            ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1.0) // spring-ish ease-out
            ctx.allowsImplicitAnimation = true
            animator().setFrame(frame, display: true)
        }
    }

}
