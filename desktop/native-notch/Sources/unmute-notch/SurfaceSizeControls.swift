import SwiftUI
import SurfaceSizeSupport

/// Visit-scoped screen-fill control for an expanded notch surface — a track you
/// drag, not three buttons.
///
/// THE RESIZE HAPPENS WHEN YOU LET GO, NEVER WHILE YOU DRAG.
///
/// This is the whole reason the control is built this way. Resizing live would
/// move the surface — and therefore this control, which lives on it — out from
/// under the pointer mid-gesture: shrink the window and the track slides away
/// from the cursor still holding it, so the drag either breaks or starts
/// tracking a control that is no longer where the hand thinks it is. The knob
/// follows the pointer continuously (that is the feedback), the label reads the
/// live value, and the SURFACE only moves once on release.
///
/// A settle delay after release, before the resize, for two reasons: an
/// adjustment is usually several small drags rather than one, and a resize that
/// begins the instant the button lifts feels like it fired at the release
/// rather than at the choice.
struct SurfaceSizeControls: View {
    @ObservedObject var model: NotchModel

    /// Where the knob is while a drag is in flight. Nil when not dragging, so
    /// the control reads from the model the rest of the time and cannot drift
    /// from what is actually on screen.
    @State private var dragFill: CGFloat?
    @State private var commit: DispatchWorkItem?

    /// Long enough to absorb a series of small adjustments, short enough that
    /// the surface does not feel like it forgot.
    private static let settle: TimeInterval = 0.35

    private var shown: CGFloat { dragFill ?? model.selectedSurfaceFill }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.up.left.and.arrow.down.right")
                .font(Theme.controlIcon)
                .foregroundColor(Theme.textFaint)
            track
            Text("\(Int((shown * 100).rounded()))%")
                .font(Theme.fCap)
                .monospacedDigit()
                .foregroundColor(Theme.textDim)
                // Fixed width: the label sits beside the track and must not
                // shove it sideways as the number changes width mid-drag.
                .frame(width: 34, alignment: .trailing)
        }
        .frame(minHeight: Theme.controlHeight)
        .help("Window size")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Expanded size")
        .accessibilityValue("\(Int((shown * 100).rounded())) percent of screen")
        .accessibilityAdjustableAction { direction in
            let next = SurfaceSizeStep.next(
                after: model.selectedSurfaceFill,
                direction: direction == .increment ? .larger : .smaller,
            )
            if let next { apply(next, after: 0) }
        }
    }

    private var track: some View {
        GeometryReader { geo in
            let width = max(geo.size.width, 1)
            let x = SurfaceSizeStep.fraction(of: shown) * width

            ZStack(alignment: .leading) {
                Capsule().fill(Theme.raised)
                    .frame(height: 4)
                    .overlay(Capsule().stroke(Theme.hairline, lineWidth: 0.5))
                Capsule().fill(Theme.accent.opacity(0.55))
                    .frame(width: max(x, 0), height: 4)
                Circle()
                    .fill(Theme.accent)
                    .frame(width: 12, height: 12)
                    .overlay(Circle().stroke(Theme.hairline, lineWidth: 0.5))
                    .offset(x: min(max(x - 6, 0), width - 12))
            }
            .frame(height: 12)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(
                // minimumDistance 0 so a plain click on the track jumps there —
                // the same gesture serves both, and a tap is a zero-length drag.
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        commit?.cancel()
                        dragFill = SurfaceSizeStep.fill(atFraction: value.location.x / width)
                    }
                    .onEnded { value in
                        let chosen = SurfaceSizeStep.fill(atFraction: value.location.x / width)
                        dragFill = chosen
                        apply(chosen, after: Self.settle)
                    },
            )
        }
        .frame(width: 88, height: 28)
    }

    /// Hand the choice to the controller, then let the control read from the
    /// model again. Clearing `dragFill` only after the work runs keeps the knob
    /// where the user left it during the settle, rather than snapping back to
    /// the old value and then forward to the new one.
    private func apply(_ fill: CGFloat, after delay: TimeInterval) {
        commit?.cancel()
        let work = DispatchWorkItem {
            model.selectSurfaceFill(fill)
            dragFill = nil
        }
        commit = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }
}
