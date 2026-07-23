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

    // Radii
    static let idleRadius: CGFloat = 12
    static let peekRadius: CGFloat = 20
    static let panelRadius: CGFloat = 26

    // The "live" feel. One shared spring so every morph reads as one system.
    static let morph: Animation = .spring(response: 0.36, dampingFraction: 0.80)
    static let glow: Animation = .easeInOut(duration: 1.6).repeatForever(autoreverses: true)
}
