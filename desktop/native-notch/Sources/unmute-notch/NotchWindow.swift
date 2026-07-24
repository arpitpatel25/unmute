import AppKit

// The floating notch panel. Non-activating so clicking the SMALL states never
// pulls focus. The EXPANDED states (task/cockpit) contain text fields and the
// live terminal, which need key events — so key-ability is toggled by state:
// small = never key; expanded = may become key when the user interacts.
final class NotchWindow: NSPanel {

    /// Flipped by AppController on state changes.
    var allowsKey = false { didSet { if !allowsKey && isKeyWindow { resignKey() } } }

    init(geometry: NotchGeometry) {
        super.init(
            contentRect: geometry.windowFrame(for: .dormant),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = .screenSaver
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false                  // the shape draws its own
        hidesOnDeactivate = false
        isMovableByWindowBackground = false
        becomesKeyOnlyIfNeeded = true      // fields/terminal claim key on click; body clicks don't
    }

    override var canBecomeKey: Bool { allowsKey }
    override var canBecomeMain: Bool { false }

    func present() { orderFrontRegardless() }

    /// Resize + reposition to an explicit top-pinned frame, spring-eased.
    func applyFrame(_ frame: NSRect, animated: Bool) {
        guard animated else { setFrame(frame, display: true); return }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.34
            ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1.0)
            ctx.allowsImplicitAnimation = true
            animator().setFrame(frame, display: true)
        }
    }
}
