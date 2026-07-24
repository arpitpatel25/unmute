import SwiftUI

// Monochrome, minimal, Dynamic-Island restraint. Color encodes EXACTLY ONE
// variable — task status (the wall's R1 rule). Motion is the personality.
enum Theme {
    // Surfaces
    static let fill = Color(white: 0.02)              // near-black notch body
    static let fillElevated = Color(red: 0.051, green: 0.059, blue: 0.071) // wall bg (#0d0f12)
    static let cardBg = Color(white: 0.055)
    static let hairline = Color(white: 1.0, opacity: 0.09)
    static let railBg = Color(white: 1.0, opacity: 0.015)

    // Text
    static let text = Color(white: 0.94)
    static let textDim = Color(white: 0.60)
    static let textFaint = Color(white: 0.40)

    // Status hues (the ONE color variable — matches the wall's STATUS map)
    static let cWorking = Color(red: 0.36, green: 0.72, blue: 0.55)   // green
    static let cNeeds   = Color(red: 0.90, green: 0.65, blue: 0.24)   // amber
    static let cReady   = Color(red: 0.34, green: 0.75, blue: 0.76)   // cyan
    static let cError   = Color(red: 0.89, green: 0.41, blue: 0.37)   // red
    static let cDone    = Color(white: 0.42)                          // gray

    static func status(_ s: TaskStatus) -> Color {
        switch s {
        case .processing: return cWorking
        case .needsUser:  return cNeeds
        case .ready:      return cReady
        case .stuck, .failed: return cError
        case .done:       return cDone
        }
    }
    static func statusLabel(_ s: TaskStatus) -> String {
        switch s {
        case .processing: return "working"
        case .needsUser:  return "needs you"
        case .ready:      return "ready"
        case .stuck:      return "stuck"
        case .failed:     return "errored"
        case .done:       return "done"
        }
    }

    // Accent (attention ring on the small states) = the needs-you amber.
    static let accent = cNeeds
    static let accentDim = cNeeds.opacity(0.32)
    static let pinGold = Color(red: 0.91, green: 0.76, blue: 0.35)

    // Shape params per state: (bottomRadius, top corner radius).
    // Top corners are SQUARE flush to the screen edge — no concave cuts
    // (removed per field feedback 2026-07-24).
    static func radius(for state: NotchState) -> CGFloat {
        switch state {
        case .dormant: return 4
        case .idle: return 12
        case .active, .attention: return 14
        case .task: return 22
        case .cockpit: return 26
        }
    }

    // Motion: expand leads with the shape; collapse is snappier.
    static let morph: Animation = .spring(response: 0.42, dampingFraction: 0.82)
    static let collapse: Animation = .spring(response: 0.30, dampingFraction: 0.86)
}
