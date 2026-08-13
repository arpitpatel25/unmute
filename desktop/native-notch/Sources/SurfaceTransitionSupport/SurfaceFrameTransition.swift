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

/// Keeps a pocket-to-expanded content handoff alive when duplicate IPC state
/// updates arrive before the delayed expanded content has mounted.
public enum SurfaceContentHandoff {
    public static func shouldPreserve(
        wasExpanded: Bool,
        destinationExpanded: Bool,
        contentReady: Bool,
        hasPocketSnapshot: Bool
    ) -> Bool {
        wasExpanded && destinationExpanded && !contentReady && hasPocketSnapshot
    }
}
