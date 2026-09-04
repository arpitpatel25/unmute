import AppKit
import SwiftUI
import PocketSwipeSupport

/// THE SWIPE, WIRED TO THE SURFACE.
///
/// `PocketSwipe` decides; this only feeds it and reports where the pointer is.
///
/// ── WHY A LOCAL EVENT MONITOR AND NOT A VIEW THAT TAKES THE MOUSE ──────────
///
/// A scroll event is delivered to the view `hitTest` returns, so a view that
/// wanted the wheel would also have to accept clicks — and this surface is
/// made of clicks: the card expands, the two round buttons close and open the
/// dashboard, the arrows still walk. Any catcher sitting over them either
/// swallows those or has to re-deliver them by hand.
///
/// So the catcher is transparent to the mouse (`hitTest` returns nil, exactly
/// as `ResizeBorderView` does outside its band) and reads the wheel from the
/// app's own event stream instead, accepting only what actually lands inside
/// its bounds. Hovering the pocket IS the containment test — there is no
/// second notion of hover to keep in sync with the first.
struct PocketSwipeArea: NSViewRepresentable {
    /// False with one card or none: there is nowhere to swipe to, and a
    /// gesture that silently does nothing is worse than no gesture.
    var enabled: Bool
    var onStep: (Int) -> Void

    func makeNSView(context: Context) -> PocketSwipeCatcher {
        let view = PocketSwipeCatcher()
        view.enabled = enabled
        view.onStep = onStep
        return view
    }

    func updateNSView(_ view: PocketSwipeCatcher, context: Context) {
        // Losing the second card mid-gesture must not leave half a swipe
        // banked for the next time the pocket fills up.
        if view.enabled != enabled { view.abandon() }
        view.enabled = enabled
        view.onStep = onStep
    }

    static func dismantleNSView(_ view: PocketSwipeCatcher, coordinator: ()) {
        view.stopWatching()
    }
}

final class PocketSwipeCatcher: NSView {
    var enabled = true
    var onStep: (Int) -> Void = { _ in }

    private var swipe = PocketSwipe()
    private var monitor: Any?

    /// INVISIBLE TO THE MOUSE. Everything under this view — the card, the two
    /// buttons, the arrows — behaves exactly as it did before it existed.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window == nil ? stopWatching() : startWatching()
    }

    private func startWatching() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            guard let self else { return event }
            return self.handle(event) ? nil : event
        }
    }

    func stopWatching() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        abandon()
    }

    func abandon() { swipe.reset() }

    /// True when the event was ours and has been spent.
    private func handle(_ event: NSEvent) -> Bool {
        guard enabled, let window, event.window === window else { return false }
        guard bounds.contains(convert(event.locationInWindow, from: nil)) else {
            // Scrolling elsewhere ends whatever was in flight here, so a swipe
            // cannot be assembled from two passes over the surface.
            abandon()
            return false
        }
        let sample = PocketSwipe.Sample(
            deltaX: event.scrollingDeltaX,
            deltaY: event.scrollingDeltaY,
            isMomentum: event.momentumPhase != [],
            isGestureStart: event.phase.contains(.began),
            isGestureEnd: event.phase.contains(.ended) || event.phase.contains(.cancelled),
            hasPreciseDeltas: event.hasPreciseScrollingDeltas
        )
        guard let step = swipe.feed(sample) else { return false }
        NotchLog.log("pocket: swipe step=\(step)")
        onStep(step)
        return true
    }
}
