import CoreGraphics

/// TWO FINGERS OVER THE POCKET, AND IT TURNS.
///
/// Moving between held tasks was a click on ‹ or ›: two 18pt targets on a
/// surface that lives in the menu bar, hit one at a time. The carousel is the
/// pocket's main verb, so the cheapest gesture on the machine should do it —
/// swipe over the card the way you swipe between photos, and the arrows stay
/// for the pointer that would rather click.
///
/// This is the ARITHMETIC of that gesture, kept away from AppKit so it can be
/// tested: the view feeds it samples and it answers with a step or nothing.
/// Every number below is behaviour, and a wrong one is invisible in a diff.
public struct PocketSwipe {
    /// One scroll event, stripped to what the decision actually needs.
    public struct Sample: Equatable {
        /// AppKit's `scrollingDeltaX` — already carrying the user's
        /// natural-scrolling preference, exactly as a scroll view reads it.
        public var deltaX: CGFloat
        public var deltaY: CGFloat
        /// The glide AFTER the fingers leave. See `feed`.
        public var isMomentum: Bool
        /// `phase == .began` — fingers landed.
        public var isGestureStart: Bool
        /// `phase == .ended || .cancelled` — fingers lifted.
        public var isGestureEnd: Bool
        /// False for an old notched wheel, which has no phases at all.
        public var hasPreciseDeltas: Bool

        public init(deltaX: CGFloat, deltaY: CGFloat,
                    isMomentum: Bool = false,
                    isGestureStart: Bool = false,
                    isGestureEnd: Bool = false,
                    hasPreciseDeltas: Bool = true) {
            self.deltaX = deltaX
            self.deltaY = deltaY
            self.isMomentum = isMomentum
            self.isGestureStart = isGestureStart
            self.isGestureEnd = isGestureEnd
            self.hasPreciseDeltas = hasPreciseDeltas
        }
    }

    /// How far the fingers must travel before the card turns. Short enough to
    /// feel like a flick, long enough that a trackpad brushed on the way past
    /// the menu bar does not re-aim your voice at a different task.
    public static let threshold: CGFloat = 26
    /// Horizontal must beat vertical by this much. A swipe is never perfectly
    /// straight, and a mostly-vertical scroll that happens to drift sideways is
    /// not a swipe at all.
    public static let axisRatio: CGFloat = 1.4
    /// A notched wheel arrives pre-quantised: one detent is already one step.
    public static let wheelDetent: CGFloat = 0.5

    private var travelX: CGFloat = 0
    private var travelY: CGFloat = 0
    /// ONE SWIPE, ONE CARD. Without this a single long drag walks the whole
    /// crank and lands somewhere you did not choose.
    private var spent = false

    public init() {}

    /// Feed one event. Returns `+1` (next), `-1` (previous), or nil.
    ///
    /// DIRECTION follows the platform, not a preference of ours: fingers left
    /// pushes the content left and brings the NEXT card in from the right,
    /// which is a negative `scrollingDeltaX` — the same sign a scroll view
    /// would use to advance. Because AppKit has already applied the user's
    /// natural-scrolling setting, inverting it here would break the gesture for
    /// exactly the people who changed the setting.
    ///
    /// MOMENTUM IS NOT A GESTURE. The glide after the fingers lift is one
    /// gesture's worth of travel arriving as a second, longer one — honouring
    /// it would turn every flick into two or three cards.
    public mutating func feed(_ s: Sample) -> Int? {
        if s.isMomentum { return nil }

        // A wheel has no phases, so there is no gesture to latch or to end:
        // each detent is its own step.
        guard s.hasPreciseDeltas else {
            guard abs(s.deltaX) >= Self.wheelDetent,
                  abs(s.deltaX) > abs(s.deltaY) else { return nil }
            return s.deltaX < 0 ? 1 : -1
        }

        if s.isGestureStart { reset() }
        if s.isGestureEnd {
            reset()
            return nil
        }

        travelX += s.deltaX
        travelY += s.deltaY
        guard !spent,
              abs(travelX) >= Self.threshold,
              abs(travelX) > abs(travelY) * Self.axisRatio else { return nil }

        spent = true
        return travelX < 0 ? 1 : -1
    }

    /// Forget the gesture in flight — the pocket closed, or the pointer left.
    public mutating func reset() {
        travelX = 0
        travelY = 0
        spent = false
    }
}
