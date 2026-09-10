/// A surface resize can rebuild AppKit/SwiftUI tracking regions and emit a
/// synthetic mouse-exit while the pointer has not moved. Only the physical
/// pointer position decides whether a revealed surface may collapse.
public enum HoverExitDecision: Equatable {
    case keepRevealed
    case acceptExit

    public static func resolve(pointerInsideSurface: Bool) -> Self {
        pointerInsideSurface ? .keepRevealed : .acceptExit
    }
}

/// Whether a hover-only reveal may return behind a physical camera housing.
/// An explicit pocket open is user state, not hover state, and therefore never
/// participates in the dormant ladder.
public enum HoverSleepPolicy {
    public static func shouldSleep(
        hasPhysicalNotch: Bool,
        pocketOpen: Bool,
        currentStateIsIdle: Bool,
        commandedStateIsDormant: Bool,
        hovering: Bool
    ) -> Bool {
        hasPhysicalNotch
            && !pocketOpen
            && currentStateIsIdle
            && commandedStateIsDormant
            && !hovering
    }
}
