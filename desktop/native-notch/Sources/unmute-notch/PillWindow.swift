import AppKit
import SwiftUI

// THE WINDOW IS A FIXED WIDE CANVAS, and the cluster centres itself in it.
//
// It was content-sized, driven by a layout preference — which meant the window
// was its INITIAL 320pt wide for the first layout pass while the cluster needed
// ~600pt. SwiftUI resolves a too-narrow row of Menus by collapsing them into an
// "⋯ More…" overflow, so the pill appeared as an overflow menu until the
// preference caught up (and sometimes never did, since the preference cannot
// fire for a layout that was itself constrained). A window that is always wider
// than its content cannot produce that state.
//
// Clicks in the empty area still pass through: nothing is drawn there, and
// NSHostingView hit-tests against SwiftUI content, so a transparent region with
// no background and no contentShape returns nil and the app underneath gets the
// event. That is why the root view must never take a background.

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

    /// Bottom-centre of the PRIMARY display's visible frame, so it clears the
    /// Dock. Fixed size — the cluster centres inside it and never resizes the
    /// window, so the pill does not shift as chips join and leave.
    func fit(geometry: NotchGeometry) {
        let frame = geometry.pillFrame()
        guard frame != self.frame else { return }
        setFrame(frame, display: true)
    }
}

/// Wraps PillView. Deliberately takes NO background — see the note above: a
/// background here would make the whole canvas swallow clicks meant for the app
/// underneath.
struct PillHost: View {
    @ObservedObject var model: PillModel
    @ObservedObject var scratch: ScratchpadModel

    var body: some View {
        PillView(model: model, scratch: scratch)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
    }
}
