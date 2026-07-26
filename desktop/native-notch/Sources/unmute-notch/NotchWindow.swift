import AppKit

/// What a resizable notch surface needs from its controller. One gesture, both
/// axes — see AppController.continueResize.
protocol NotchResizing: AnyObject {
    func beginResize(at pointInWindow: NSPoint)
    func continueResize()
    func endResize()
}

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

    /// Drag anywhere in the outer border to resize. Routed to the controller,
    /// which scales BOTH axes from one gesture.
    weak var resizer: NotchResizing?
    /// How wide the grab border is. Generous, because it is invisible.
    private let grabInset: CGFloat = 10
    private var resizing = false

    private func onBorder(_ p: NSPoint) -> Bool {
        guard allowsKey else { return false }          // only the expanded surfaces
        let b = bounds(ofContent: true)
        return !b.insetBy(dx: grabInset, dy: grabInset).contains(p) && b.contains(p)
    }

    private func bounds(ofContent: Bool) -> NSRect {
        NSRect(origin: .zero, size: frame.size)
    }

    override func mouseDown(with event: NSEvent) {
        if onBorder(event.locationInWindow) {
            resizing = true
            resizer?.beginResize(at: event.locationInWindow)
            return
        }
        super.mouseDown(with: event)
    }

    override func mouseDragged(with event: NSEvent) {
        if resizing { resizer?.continueResize(); return }
        super.mouseDragged(with: event)
    }

    override func mouseUp(with event: NSEvent) {
        if resizing { resizing = false; resizer?.endResize(); return }
        super.mouseUp(with: event)
    }

    override func cursorUpdate(with event: NSEvent) {
        if onBorder(event.locationInWindow) { NSCursor.crosshair.set() } else { super.cursorUpdate(with: event) }
    }
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
