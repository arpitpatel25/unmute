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
