import AppKit
import QuartzCore
import SurfaceTransitionSupport

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
            contentRect: geometry.dormantFrame(),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = .screenSaver
        // NO `.stationary` — IT STRANDS THE GLASS.
        //
        // `.stationary` means "do not take part in Space transitions". A window
        // that sits out the transition never has its behind-window backdrop
        // re-bound to the newly active Space, so the material goes on
        // compositing the desktop it last sampled: swipe to a new Space and the
        // surface wears the OLD one's colour until something forces a redraw
        // (moving the cursor over it did, which is what made it look random).
        //
        // Proven by A/B, not reasoned: two identical vibrant panels differing
        // only in this flag, photographed in the same frame on the same Space —
        // the `.stationary` one stayed dark from a Space three swipes back while
        // the other correctly sampled the wallpaper under it. `.canJoinAllSpaces`
        // is NOT the culprit and is kept; the panel without `.stationary` still
        // appears on every Space and still tracks the backdrop.
        //
        // The cost is that these surfaces now travel with the desktop during a
        // swipe rather than staying welded to the screen edge. That is the
        // trade, and it was taken deliberately: correct glass everywhere beats
        // a pinned position during the half-second of a transition.
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        // Visible in screen sharing/screenshots by default. Settings can switch
        // this to `.none` live when the user wants the surface kept private.
        sharingType = .readOnly
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

    /// AppKit owns window movement. SwiftUI receives the matching state change
    /// in AppController's single transaction; this method only changes geometry.
    /// Repeating an in-flight target is intentionally a no-op, so a pocket or
    /// content update cannot restart an otherwise healthy resize.
    func applyFrame(_ frame: NSRect, animated: Bool) {
        switch frameTransition.request(frame, from: self.frame, animated: animated && !Motion.reduceMotion) {
        case .none:
            return
        case let .setImmediately(target):
            frameAnimator?.cancel()
            frameAnimator = nil
            setFrame(target, display: true)
        case let .animate(target):
            animateFrame(from: self.frame, to: target)
        case let .animateFrom(current, to: target):
            animateFrame(from: current, to: target)
        }
    }

    private func animateFrame(from: NSRect, to: NSRect) {
        frameAnimator?.cancel()
        let animator = DisplayLinkedFrameAnimator(window: self, from: from, to: to,
                                                  duration: Theme.surfaceTransitionDuration)
        frameAnimator = animator
        animator.start { [weak self, weak animator] in
            guard self?.frameAnimator === animator else { return }
            self?.frameAnimator = nil
        }
    }

    private var frameTransition = SurfaceFrameTransition()
    private var frameAnimator: DisplayLinkedFrameAnimator?
}

/// Moves panel geometry one display sample at a time and returns immediately.
/// AppKit's `setFrame(... animate: true)` runs a synchronous animation context;
/// mounting the expanded SwiftUI tree inside it made the IPC handler block for
/// seconds. This coordinator owns only geometry and can be retargeted safely.
private final class DisplayLinkedFrameAnimator: NSObject {
    private weak var window: NSWindow?
    private let from: NSRect
    private let to: NSRect
    private let duration: CFTimeInterval
    private var startedAt: CFTimeInterval = 0
    private var link: AnyObject?
    private var timer: Timer?
    private var completion: (() -> Void)?

    init(window: NSWindow, from: NSRect, to: NSRect, duration: TimeInterval) {
        self.window = window
        self.from = from
        self.to = to
        self.duration = max(duration, 0.001)
    }

    func start(completion: @escaping () -> Void) {
        self.completion = completion
        startedAt = CACurrentMediaTime()
        if #available(macOS 14.0, *), let window {
            let displayLink = window.displayLink(target: self, selector: #selector(step))
            displayLink.add(to: .main, forMode: .common)
            link = displayLink
        } else {
            let timer = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in self?.tick() }
            RunLoop.main.add(timer, forMode: .common)
            self.timer = timer
        }
    }

    func cancel() {
        timer?.invalidate()
        timer = nil
        if #available(macOS 14.0, *), let displayLink = link as? CADisplayLink { displayLink.invalidate() }
        link = nil
        completion = nil
    }

    @objc private func step() { tick() }

    private func tick() {
        guard let window else { cancel(); return }
        let raw = min(max((CACurrentMediaTime() - startedAt) / duration, 0), 1)
        // Smoothstep: zero velocity at both ends, with no overshoot or bounce.
        let eased = raw * raw * (3 - 2 * raw)
        let frame = SurfaceFrameTransition.sample(from: from, to: to, progress: CGFloat(eased))
        window.setFrame(frame.integral, display: true)
        guard raw >= 1 else { return }
        window.setFrame(to, display: true)
        let done = completion
        cancel()
        done?()
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
