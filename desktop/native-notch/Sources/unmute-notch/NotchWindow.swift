import AppKit
import QuartzCore

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
        // NEVER IN THE USER'S SCREENSHOT.
        //
        // Taking a screenshot to answer a task meant fighting the surface that
        // asked the question: ⌘⇧4 caught the panel sitting over the very thing
        // being captured, so the shot had to be retaken after putting Unmute
        // away. `.none` removes the window from screen capture and screen
        // sharing outright, which solves that whole class of annoyance rather
        // than timing our way around it — and, as a bonus, keeps your task list
        // out of a shared screen.
        //
        // The trade: you cannot deliberately screenshot the surface either. A
        // support request needing a picture of the notch has to be a photo or a
        // description. That is the right side of the trade for a panel whose
        // job is to sit on top of everything you do.
        sharingType = .none
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

    /// Resize + reposition to an explicit top-pinned frame, on THE spring.
    ///
    /// `expanding` decides the axis order and nothing else:
    ///   * expanding — WIDTH LEADS, height follows `Theme.axisLag` behind, so
    ///     the surface unfurls
    ///   * collapsing — strictly the reverse, height first, so it folds
    ///
    /// Asymmetry here makes a surface feel unreliable even when nobody can say
    /// why, which is why the two orders are the same list read backwards.
    ///
    /// Both axes travel on Theme.springSolver — the same response and damping
    /// the SwiftUI animation inside the window is using. There is no second
    /// curve anywhere in the resize path: NSAnimationContext only offers bezier
    /// timing, so the frame is sampled by hand rather than given a curve of its
    /// own.
    func applyFrame(_ frame: NSRect, animated: Bool, expanding: Bool = true) {
        frameSpring?.cancel()
        frameSpring = nil
        // Reduce Motion: no spring, no stagger, nothing to track. The surface
        // still changes — it simply arrives.
        guard animated, !Motion.reduceMotion else { setFrame(frame, display: true); return }
        guard self.frame != frame else { return }
        let s = FrameSpring(window: self, from: self.frame, to: frame,
                            widthDelay: expanding ? 0 : Theme.axisLag,
                            heightDelay: expanding ? Theme.axisLag : 0)
        frameSpring = s
        s.start()
    }

    private var frameSpring: FrameSpring?
}

/// One resize, sampled from Theme.springSolver, with an independent start time
/// per axis.
///
/// A window frame cannot be animated by SwiftUI and NSAnimationContext has no
/// spring, so this is what keeps the container on the same curve as everything
/// drawn inside it. x travels with the width and y with the height, which
/// preserves the top-pinned, cutout-anchored placement at both ends of the
/// journey and everywhere in between.
final class FrameSpring: NSObject {
    private weak var window: NSWindow?
    private let from: NSRect
    private let to: NSRect
    private let widthDelay: Double
    private let heightDelay: Double
    private let solver = Theme.springSolver
    private var timer: Timer?
    private var link: AnyObject?
    private var start0: CFTimeInterval = 0

    init(window: NSWindow, from: NSRect, to: NSRect, widthDelay: Double, heightDelay: Double) {
        self.window = window
        self.from = from
        self.to = to
        self.widthDelay = widthDelay
        self.heightDelay = heightDelay
    }

    func start() {
        start0 = CACurrentMediaTime()
        // DRIVEN BY THE DISPLAY, not by a clock, wherever macOS offers it: this
        // moves a window frame, and a timer that drifts against the refresh
        // shows up as stutter the SwiftUI side of the same spring does not
        // share. Both paths run in .common mode so a menu tracking loop or a
        // drag elsewhere cannot freeze the surface mid-morph.
        // DO NOT MAKE `link` WEAK, AND DO NOT WEAKEN THE TARGET. The run loop
        // owns the display link and the link owns its target, which is what
        // keeps this object alive for the half-second it is animating; the
        // window's `frameSpring` reference is the other half. `cancel()` breaks
        // both, and every path out of here calls it. A "fix" that weakens either
        // side deallocates the animator mid-morph and the surface freezes
        // part-way to its new size.
        if #available(macOS 14.0, *), let w = window {
            let dl = w.displayLink(target: self, selector: #selector(step))
            dl.add(to: .main, forMode: .common)
            link = dl
            return
        }
        let t = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func cancel() {
        timer?.invalidate()
        timer = nil
        if #available(macOS 14.0, *), let dl = link as? CADisplayLink { dl.invalidate() }
        link = nil
    }

    @objc private func step() { tick() }

    private func tick() {
        guard let window else { cancel(); return }
        let t = CACurrentMediaTime() - start0
        let wp = solver.value(at: t - widthDelay)
        let hp = solver.value(at: t - heightDelay)
        let w = from.width + (to.width - from.width) * wp
        let h = from.height + (to.height - from.height) * hp
        let x = from.origin.x + (to.origin.x - from.origin.x) * wp
        let y = from.origin.y + (to.origin.y - from.origin.y) * hp
        window.setFrame(NSRect(x: round(x), y: round(y), width: round(w), height: round(h)),
                        display: true)
        if t >= solver.settle + max(widthDelay, heightDelay) {
            window.setFrame(to, display: true)
            cancel()
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
