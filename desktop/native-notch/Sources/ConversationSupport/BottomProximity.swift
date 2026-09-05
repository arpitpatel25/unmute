// "AM I AT THE BOTTOM OF THE TRANSCRIPT?" — asked of a measurement, and asked
// with hysteresis, so the answer cannot be changed by what the answer draws.
//
// THE FAILURE THIS REPLACES. The flag was set by whether a one-point marker view
// happened to be on screen:
//
//     Color.clear.frame(height: 1).background(BottomWatcher(atBottom: $atBottom))
//     ...
//     if !atBottom { JumpToLatest(...) }        // in the same ZStack
//
// so: marker visible → atBottom true → the Jump control leaves the stack → the
// stack resizes → the marker moves → onDisappear → atBottom false → the control
// returns → the stack resizes back. Every step correct, the sequence endless.
// SwiftUI has no "this is not converging" detector; it simply recomputes layout
// forever. In the field that pinned a core at 100%, and because the notch window
// is `.screenSaver` level with `.canJoinAllSpaces`, the frozen surface sat above
// every window on every desktop and could not be dismissed — the app it belongs
// to was still healthy, so quitting it changed nothing.
//
// TWO PROPERTIES MAKE IT IMPOSSIBLE RATHER THAN UNLIKELY:
//
//   1. The input is a DISTANCE, read from geometry. A number cannot be altered
//      by deciding to draw a button; a view's visibility can.
//   2. The thresholds are asymmetric, and the dead zone between them is wider
//      than the control itself. Even if showing the control shifts the content
//      by its full height, that shift cannot carry the value back across the
//      boundary — which is the loop's only remaining way to close.
//
// The second is the part that generalises: any state that both reads layout and
// changes layout needs a dead zone bigger than its own effect.

import CoreGraphics

/// Height the Jump-to-latest control occupies, including its padding. The dead
/// zone below is sized against this, so keep them together.
public let jumpControlHeight: CGFloat = 44

/// Within this of the end, you count as arrived.
public let bottomEnterThreshold: CGFloat = 8

/// You are only "away" once past this — deliberately far beyond
/// `bottomEnterThreshold + jumpControlHeight`, so the control cannot flip its
/// own condition, and a reader who scrolled up is not snapped back by a nudge.
public let bottomExitThreshold: CGFloat = 120

/// Fold a fresh measurement into the flag.
///
/// - Parameters:
///   - was: the current answer. Hysteresis needs to know where it is coming from.
///   - distance: points between the viewport's bottom edge and the content's end.
///     Non-finite means "not measured yet" — keep the previous answer rather than
///     inventing one that could scroll the reader.
public func isAtBottom(was: Bool, distance: CGFloat) -> Bool {
    guard distance.isFinite else { return was }
    let d = max(0, distance)
    return was ? d <= bottomExitThreshold : d <= bottomEnterThreshold
}

public func proseMeasure(panelWidth: CGFloat) -> CGFloat {
    min(760, max(0, panelWidth - 96))
}

public func codeMeasure(panelWidth: CGFloat) -> CGFloat {
    max(0, panelWidth - 96)
}
