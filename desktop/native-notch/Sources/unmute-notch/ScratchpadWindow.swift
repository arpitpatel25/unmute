import AppKit
import SwiftUI

// THE PAD'S PANEL — the same window contract as the pill, for the same reason.
//
// IT MUST NOT TAKE FOCUS. The user is about to deliver this pad into a text
// field behind it; if clicking the pad makes it key, the insertion point they
// are aiming at dies and "Paste at cursor" pastes into nothing. So every flag
// below is copied from PillWindow deliberately rather than approximated:
// `.nonactivatingPanel` in the style mask, canBecomeKey/canBecomeMain false,
// `becomesKeyOnlyIfNeeded`, and `orderFrontRegardless()` to show without
// activating the app. A borderless panel that merely LOOKS passive still steals
// first responder the moment it is clicked.
//
// LIKE THE PILL, IT IS A FIXED CANVAS the content aligns inside, not a window
// sized to its content. The root view takes no background, so the empty area
// hit-tests to nil and clicks pass through to the app underneath (see
// PillWindow's note — this is the same mechanism, and the same reason the host
// view must never take a background).

final class ScratchpadWindow: NSPanel {

    /// Wide enough for the 340pt panel plus breathing room, tall enough for the
    /// scroller at its 320pt ceiling plus header and footer.
    static let canvas = NSSize(width: 380, height: 460)

    init() {
        super.init(
            contentRect: NSRect(origin: .zero, size: Self.canvas),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = .screenSaver
        // No `.stationary` — see PillWindow: it strands the glass on the Space
        // it last sampled.
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        hidesOnDeactivate = false
        isMovableByWindowBackground = false
        becomesKeyOnlyIfNeeded = true
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    func present() { orderFrontRegardless() }

    /// Directly above where the pill's cluster sits, on the primary display.
    ///
    /// ANCHORED TO THE CLUSTER'S SLOT, NOT TO THE PILL'S VISIBILITY. The pill
    /// comes and goes with each capture while the pad persists across several,
    /// so tying the pad's position to whether a pill happens to be on screen
    /// would make it hop up and down every time recording started and stopped.
    /// It sits above the slot the cluster occupies, full stop.
    func fit(geometry: NotchGeometry) {
        let pill = geometry.pillFrame()
        // pillFrame's canvas is bottom-aligned: the cluster sits `4` up from its
        // bottom edge and is PillMetrics.height tall (see PillView.content).
        let clusterTop = pill.minY + 4 + PillMetrics.height
        let frame = NSRect(x: round(pill.midX - Self.canvas.width / 2),
                           y: round(clusterTop + 9),          // the cluster's own row spacing
                           width: Self.canvas.width,
                           height: Self.canvas.height)
        guard frame != self.frame else { return }
        setFrame(frame, display: true)
    }
}

/// Wraps ScratchpadView. Takes NO background — see the note above: a background
/// here would make the whole canvas swallow clicks meant for the app beneath.
struct ScratchpadHost: View {
    @ObservedObject var model: ScratchpadModel

    var body: some View {
        Group {
            if let pad = model.state.pad, model.visible {
                ScratchpadView(
                    pad: pad,
                    destinations: model.state.destinations,
                    armed: model.state.armed,
                    delivering: model.state.delivering,
                    onRemove: { model.emit(.scratchpadRemove(id: $0)) },
                    onDeliver: { model.emit(.scratchpadDeliver(dest: $0)) },
                    onDiscard: { model.emit(.scratchpadDiscard) }
                )
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
    }
}
