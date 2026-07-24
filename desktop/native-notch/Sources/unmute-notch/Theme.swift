import SwiftUI

// Monochrome, minimal, Dynamic-Island-restraint. Color is not decoration here —
// the personality is motion (the spring), not hue. Exactly one accent (amber)
// for "needs you"; everything else is near-black + hairline + soft gray.
enum Theme {
    // Surfaces
    static let fill = Color(white: 0.04)              // near-black notch body
    static let fillElevated = Color(white: 0.08)      // panel body
    static let hairline = Color(white: 1.0, opacity: 0.10)

    // Text
    static let text = Color(white: 0.96)
    static let textDim = Color(white: 0.62)

    // The single accent, used sparingly for your-move attention.
    static let accent = Color(red: 1.0, green: 0.72, blue: 0.20)   // amber
    static let accentDim = Color(red: 1.0, green: 0.72, blue: 0.20).opacity(0.35)

    // NotchShape params per state: (bottomRadius, shoulder concave fillet).
    static func shape(for state: NotchState) -> (bottom: CGFloat, shoulder: CGFloat) {
        switch state {
        case .dormant:   return (4, 3)
        case .idle:      return (12, 10)
        case .active, .attention: return (14, 11)
        case .task:      return (22, 13)
        case .cockpit:   return (26, 14)
        }
    }

    // The "live" feel. One shared spring so every morph reads as one system.
    // Expand leads with the shape; collapse is a touch snappier.
    static let morph: Animation = .spring(response: 0.42, dampingFraction: 0.82)
    static let collapse: Animation = .spring(response: 0.30, dampingFraction: 0.86)
    static let glow: Animation = .easeInOut(duration: 1.6).repeatForever(autoreverses: true)
}
