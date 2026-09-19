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
import Foundation

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

/// Points of content still BELOW the viewport's bottom edge.
///
/// `contentEnd` is the transcript's end (its maxY) in the scroll viewport's own
/// coordinate space, so it is larger than `viewportHeight` exactly when there is
/// more to read below the fold. At the real bottom it is NEGATIVE — the end sits
/// `jumpControlHeight` above the edge because of the padding the control floats
/// over — and `isAtBottom` clamps that to zero.
///
/// THE SIGN HAS BEEN WRONG BEFORE. The call site once computed
/// `viewportHeight - end`, which is negative whenever the reader has scrolled
/// up; the clamp turned that into "at the bottom", so every streaming tick
/// yanked the reader back to the live end. Keep the arithmetic here, under test.
///
/// Non-finite, or a viewport not yet measured, returns NaN — "unknown", which
/// `isAtBottom` answers by keeping the previous state.
public func bottomDistance(contentEnd: CGFloat, viewportHeight: CGFloat) -> CGFloat {
    guard contentEnd.isFinite, viewportHeight.isFinite, viewportHeight > 0 else { return .nan }
    return contentEnd - viewportHeight
}

/// How long after the reader's last scroll input the live end may not move them.
/// Covers the gap between discrete mouse-wheel clicks (which post no live-scroll
/// notifications) and the tail of a trackpad gesture.
public let userScrollGrace: TimeInterval = 0.35

/// SHOULD THE NEXT STREAMING TICK MOVE THE READER TO THE LIVE END?
///
/// Only when they are already there AND their hands are off the scroller.
///
/// This is a value type with no view in it. The SwiftUI side keeps it in a
/// reference box that nothing renders from, so changing it can never change
/// layout — the rule the top of this file is about. The flag feeds one thing:
/// whether a follow happens.
///
/// THE READER LEAVES THE BOTTOM ONLY BY MOVING. Content growth alone must never
/// clear the flag: a tick that lands a 300pt block before the follow has run
/// measures as "far from the end", and taking that at face value would stop
/// following on the reader's behalf. So a measurement may clear the flag only
/// when the viewport itself moved up (the content's top came down), and an
/// upward wheel or trackpad movement clears it outright — no 120pt of drag
/// during which a tick can snap them back. Re-arming likewise needs the viewport
/// to move down to the end.
public struct LiveEndFollow: Equatable {
    public private(set) var atBottom = true
    /// Content top (minY in viewport space) at the last measurement. It moves
    /// only when the viewport scrolls; content growth extends the other end.
    public private(set) var lastTop: CGFloat = .nan
    public private(set) var lastDistance: CGFloat = .nan
    private var liveScrolling = false
    private var liveStartTop: CGFloat = .nan
    private var lastUserScroll: TimeInterval = -.infinity

    public init() {}

    /// A different thread, positioned by code: start following, forget the
    /// previous thread's geometry.
    public mutating func reset() {
        atBottom = true
        lastTop = .nan
        lastDistance = .nan
        liveStartTop = .nan
    }

    /// The reader asked for the live end (Jump to latest): follow it, whatever
    /// direction that scroll happened to move the viewport.
    public mutating func jumpToLatest() { atBottom = true }

    /// Fold a geometry report in. While a restore is positioning the thread the
    /// numbers are recorded but decide nothing — the scroll is ours, not theirs.
    public mutating func measure(contentTop: CGFloat, contentEnd: CGFloat, viewportHeight: CGFloat, restoring: Bool) {
        let d = bottomDistance(contentEnd: contentEnd, viewportHeight: viewportHeight)
        let movedUp = contentTop.isFinite && lastTop.isFinite && contentTop > lastTop + 0.5
        let movedDown = contentTop.isFinite && lastTop.isFinite && contentTop < lastTop - 0.5
        if contentTop.isFinite { lastTop = contentTop }
        if d.isFinite { lastDistance = d }
        guard !restoring, d.isFinite else { return }
        if atBottom {
            if movedUp { atBottom = isAtBottom(was: true, distance: d) }
        } else if movedDown {
            // Arriving, symmetrically, takes the viewport moving DOWN (the
            // reader scrolling, or Jump to latest). Without this a reader who
            // wheeled up a few lines would be re-armed at once: the Jump padding
            // puts the end up to `jumpControlHeight` above the edge, and all of
            // that still clamps to "arrived".
            atBottom = isAtBottom(was: false, distance: d)
        }
    }

    /// A wheel / trackpad event over the transcript. `deltaY > 0` is toward the
    /// top of the document (AppKit's convention, natural scrolling included).
    public mutating func userScrolled(deltaX: CGFloat, deltaY: CGFloat, at now: TimeInterval) {
        lastUserScroll = now
        // Upward and mostly vertical, and there is somewhere up to go. A wheel
        // nudge on a transcript that fits cannot move it, and must not stop the
        // follow for a reader who never left the end.
        let canMoveUp = !lastTop.isFinite || lastTop < -0.5
        if deltaY > 0, abs(deltaY) >= abs(deltaX), canMoveUp { atBottom = false }
    }

    public mutating func liveScrollBegan(at now: TimeInterval) {
        liveScrolling = true
        liveStartTop = lastTop
        lastUserScroll = now
    }

    /// A drag of the scroller (or a gesture) ended. If it carried the reader up
    /// and left them short of the end, they are reading — by the strict arrival
    /// threshold, not the generous leaving one.
    public mutating func liveScrollEnded(at now: TimeInterval) {
        liveScrolling = false
        lastUserScroll = now
        if liveStartTop.isFinite, lastTop.isFinite, lastTop > liveStartTop + 0.5, lastDistance.isFinite {
            atBottom = isAtBottom(was: false, distance: lastDistance)
        }
        liveStartTop = .nan
    }

    /// The reader's hands are on the scroller, or were a moment ago.
    public func userIsScrolling(at now: TimeInterval) -> Bool {
        liveScrolling || now - lastUserScroll < userScrollGrace
    }

    public func mayFollow(at now: TimeInterval) -> Bool {
        atBottom && !userIsScrolling(at: now)
    }
}

public func proseMeasure(panelWidth: CGFloat) -> CGFloat {
    min(760, max(0, panelWidth - 96))
}

public func codeMeasure(panelWidth: CGFloat) -> CGFloat {
    max(0, panelWidth - 96)
}
