import CoreGraphics

/// Coalesces requests for a native window-frame transition.
///
/// The notch receives independent IPC updates for state, pocket contents and
/// task details. Several updates may resolve to the same visible geometry while
/// an AppKit animation is still travelling there. Replaying that request would
/// restart the animation from an intermediate frame, which reads as a hitch.
public struct SurfaceFrameTransition: Equatable {
    private var requestedFrame: CGRect?

    public init() {}

    /// Marks the matching request as settled. Duplicate suppression is useful
    /// only while geometry is travelling; keeping the target forever prevents
    /// the controller from correcting later WindowServer drift.
    public mutating func complete(_ frame: CGRect) {
        if requestedFrame == frame { requestedFrame = nil }
    }

    public mutating func request(
        _ target: CGRect,
        from current: CGRect,
        animated: Bool
    ) -> SurfaceFrameTransitionAction {
        guard requestedFrame != target else { return .none }
        let retargeting = requestedFrame != nil
        requestedFrame = target

        guard animated, current != target else { return .setImmediately(target) }
        if retargeting { return .animateFrom(current, to: target) }
        return .animate(target)
    }

    public static func sample(from: CGRect, to: CGRect, progress: CGFloat) -> CGRect {
        let p = min(max(progress, 0), 1)
        return CGRect(
            x: from.origin.x + (to.origin.x - from.origin.x) * p,
            y: from.origin.y + (to.origin.y - from.origin.y) * p,
            width: from.width + (to.width - from.width) * p,
            height: from.height + (to.height - from.height) * p
        )
    }
}

public enum SurfaceFrameTransitionAction: Equatable {
    case none
    case setImmediately(CGRect)
    case animate(CGRect)
    case animateFrom(CGRect, to: CGRect)
}

/// Coordinates an automatic departure from a large surface across the IPC
/// round-trip. The helper observes the app/Space change first, so it hides the
/// old large frame immediately and stays hidden through any stale expanded
/// snapshot. Only the first compact state is installed and shown atomically.
public struct SurfaceDepartureTransition: Equatable {
    private enum Phase: Equatable {
        case idle
        case awaitingCompact
        case returning
    }

    private var phase: Phase = .idle

    public init() {}

    public mutating func begin(isExpanded: Bool) -> SurfaceDepartureBeginAction {
        guard isExpanded, phase == .idle else { return .none }
        phase = .awaitingCompact
        return .hide
    }

    public mutating func receive(isExpanded: Bool) -> SurfaceDepartureReceiveAction {
        switch phase {
        case .idle:
            return .applyNormally
        case .awaitingCompact:
            guard !isExpanded else { return .applyHidden }
            phase = .idle
            return .applyImmediatelyAndShow
        case .returning:
            guard isExpanded else { return .applyHidden }
            phase = .idle
            return .applyImmediatelyAndShow
        }
    }

    public mutating func cancel() -> SurfaceDepartureCancelAction {
        guard phase == .awaitingCompact else { return .none }
        phase = .returning
        return .keepHidden
    }

    /// A return notification can arrive after the compact state has already
    /// settled. Hide that compact surface and wait for Electron's restored
    /// expanded reply so the return is atomic too.
    public mutating func returnToExpanded(isExpanded: Bool) -> SurfaceDepartureReturnAction {
        guard !isExpanded else { return .none }
        phase = .returning
        return .hideUntilExpanded
    }

    public mutating func abandonReturn() -> SurfaceDepartureAbandonAction {
        guard phase == .returning else { return .none }
        phase = .idle
        return .showCompact
    }
}

public enum SurfaceDepartureBeginAction: Equatable {
    case none
    case hide
}

public enum SurfaceDepartureReceiveAction: Equatable {
    case applyNormally
    case applyHidden
    case applyImmediatelyAndShow
}

public enum SurfaceDepartureCancelAction: Equatable {
    case none
    case keepHidden
}

public enum SurfaceDepartureReturnAction: Equatable {
    case none
    case hideUntilExpanded
}

public enum SurfaceDepartureAbandonAction: Equatable {
    case none
    case showCompact
}

/// Keeps a pocket-to-expanded content handoff alive when duplicate IPC state
/// updates arrive before the delayed expanded content has mounted.
public enum SurfaceContentHandoff {
    /// Prepared content participates in the same live resize as its container.
    /// Withholding it until the frame completes creates a blank large panel and
    /// forces its first layout onto the end of the transition.
    public static func shouldDelayExpandedContent(
        expandingFromPocket: Bool,
        contentPrepared: Bool
    ) -> Bool {
        expandingFromPocket && !contentPrepared
    }

    public static func shouldPreserve(
        wasExpanded: Bool,
        destinationExpanded: Bool,
        contentReady: Bool,
        hasPocketSnapshot: Bool
    ) -> Bool {
        wasExpanded && destinationExpanded && !contentReady && hasPocketSnapshot
    }
}

/// User-originated commands that may legitimately open a large surface even
/// when automatic presentation is disabled.
public enum SurfacePresentationGesture: Equatable {
    case tap
    case openDashboard
    case next
    case previous
    case focusTask
    case pocketExpand
    case other
}

public enum SurfacePresentationIntent {
    public static func isExplicitGesture(_ gesture: SurfacePresentationGesture) -> Bool {
        switch gesture {
        case .tap, .openDashboard, .next, .previous, .focusTask, .pocketExpand:
            return true
        case .other:
            return false
        }
    }
}

/// Decides whether an expanded command may open the large surface.
///
/// `autoPresent` controls new compact-to-expanded presentations. Once the
/// surface is already expanded, repeated task/cockpit commands are content
/// refreshes and must remain expanded regardless of that preference.
public enum SurfacePresentationPolicy {
    public static func allowsExpandedRequest(
        autoPresent: Bool,
        surfaceIsAlreadyExpanded: Bool,
        hasRecentGesture: Bool
    ) -> Bool {
        autoPresent || surfaceIsAlreadyExpanded || hasRecentGesture
    }
}

/// Whether an activated app is somewhere the user actually went. See
/// AppController.leaveIfShown.
public enum DepartureTarget: Equatable {
    case leave
    case lookAgain
    case stay

    public static func decide(hasWindowOnScreen: Bool, rechecked: Bool) -> DepartureTarget {
        if hasWindowOnScreen { return .leave }
        return rechecked ? .stay : .lookAgain
    }
}
