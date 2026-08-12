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
        requestedFrame = target

        guard animated, current != target else { return .setImmediately(target) }
        return .animate(target)
    }
}

public enum SurfaceFrameTransitionAction: Equatable {
    case none
    case setImmediately(CGRect)
    case animate(CGRect)
}
