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
        // MUST BE FALSE, or Escape leaks to the app underneath.
        //
        // `true` means "only take key when something that genuinely needs keys
        // is clicked" — which quietly undoes the explicit makeKey() in
        // applyState. The panel then became key only after you clicked INTO a
        // field, so opening the cockpit by voice, or by clicking the notch
        // body, left key focus with the app below: Escape reached only the
        // GLOBAL monitor, which macOS defines as observe-only and therefore
        // cannot consume. The surface collapsed AND the Escape also landed in
        // the user's Codex/Terminal session.
        //
        // `canBecomeKey` is already the correct gate — it returns `allowsKey`,
        // which is false for every small state. So the resting states still
        // never take key and never disturb focus; only task/cockpit do, which
        // is exactly when Escape belongs to us. This is a nonactivating panel,
        // so taking key does NOT activate the app or move the frontmost window.
        becomesKeyOnlyIfNeeded = false
    }

    override var canBecomeKey: Bool { allowsKey }

    /// Drag anywhere in the outer border to resize.
    ///
    /// Owned by an OVERLAY VIEW, not by the window. `contentView` is a
    /// full-bleed NSHostingView and SwiftUI consumes the mouse, so
    /// NSWindow.mouseDown is never called for a click that lands on it —
    /// overriding it here looked correct and ran never.
    weak var resizer: NotchResizing? { didSet { installResizeBorder() } }
    private var resizeBorder: ResizeBorderView?

    private func installResizeBorder() {
        guard resizeBorder == nil, let content = contentView else { return }
        let v = ResizeBorderView(frame: content.bounds)
        v.autoresizingMask = [.width, .height]
        v.resizer = resizer
        v.isEnabled = { [weak self] in self?.allowsKey ?? false }
        // ABOVE the hosting view, as its sibling — so it gets first refusal on
        // the mouse without SwiftUI being able to reorder it away.
        content.addSubview(v, positioned: .above, relativeTo: content.subviews.last)
        resizeBorder = v
    }

    func present() { orderFrontRegardless() }

    /// Resize + reposition to an explicit top-pinned frame, spring-eased.
    ///
    /// `duration` should MATCH the SwiftUI animation driving the content. They
    /// were 0.34s and 0.48s respectively, so the window finished resizing while
    /// the content was still mid-transition — the frame reached task size while
    /// the material still carried attention's wash.
    func applyFrame(_ frame: NSRect, animated: Bool, duration: TimeInterval = 0.42) {
        guard animated else { setFrame(frame, display: true); return }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = duration
            ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1.0)
            ctx.allowsImplicitAnimation = true
            animator().setFrame(frame, display: true)
        }
    }
}


/// The grab band around an expanded surface.
///
/// Sits ABOVE the SwiftUI hosting view but is transparent to every click except
/// those in the outer margin: `hitTest` returns nil elsewhere, so buttons,
/// fields and the terminal underneath behave exactly as before.
final class ResizeBorderView: NSView {
    weak var resizer: NotchResizing?
    var isEnabled: () -> Bool = { true }
    /// Generous, because it is invisible — found by feel, not by sight.
    private let grab: CGFloat = 14
    private var dragging = false

    private func inBand(_ p: NSPoint) -> Bool {
        guard isEnabled() else { return false }
        return bounds.contains(p) && !bounds.insetBy(dx: grab, dy: grab).contains(p)
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        // `point` arrives in the SUPERVIEW's coordinate space.
        inBand(convert(point, from: superview)) ? self : nil
    }

    override func mouseDown(with event: NSEvent) {
        dragging = true
        resizer?.beginResize(at: event.locationInWindow)
    }
    override func mouseDragged(with event: NSEvent) {
        guard dragging else { return }
        resizer?.continueResize()
    }
    override func mouseUp(with event: NSEvent) {
        dragging = false
        resizer?.endResize()
    }

    override func resetCursorRects() {
        discardCursorRects()
        guard isEnabled() else { return }
        let w = bounds.width, h = bounds.height
        for r in [NSRect(x: 0, y: 0, width: w, height: grab),
                  NSRect(x: 0, y: h - grab, width: w, height: grab),
                  NSRect(x: 0, y: 0, width: grab, height: h),
                  NSRect(x: w - grab, y: 0, width: grab, height: h)] {
            addCursorRect(r, cursor: .crosshair)
        }
    }
}
