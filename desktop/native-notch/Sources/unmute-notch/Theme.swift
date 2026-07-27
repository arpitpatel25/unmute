import SwiftUI
import AppKit

// The design system — macOS 27 "Golden Gate" / Liquid Glass.
//
// Three rules the whole surface is built from:
//
//  1. GLASS IS CHROME, NEVER CONTENT. Liquid Glass belongs to the navigation
//     layer floating above content. The four small states ARE pure chrome —
//     nothing behind them but wallpaper — so they are wholly glass. The two
//     large states are a glass SHELL wrapping an OPAQUE content plane, exactly
//     as a Mac window pairs a glass toolbar with solid content. Cards, the
//     terminal and the transcript never receive glass: glass cannot sample
//     glass, and content-layer glass has nothing behind it to refract.
//
//  2. ONE TINTED THING PER SURFACE. "When everything is tinted, nothing stands
//     out." Status stays the single encoded variable; the accent marks exactly
//     one primary action per surface. They never trade places.
//
//  3. EVERY RADIUS IS DERIVED. Concentric shapes subtract padding from the
//     parent (18 − 6 = 12). Capsules are half the height. Nothing by eye.
//
// Colors are Apple's SYSTEM palette, not hand-mixed. Apple retuned these
// specifically to improve hue differentiation against translucent material, and
// they adapt per appearance for free — which hand-picked RGB never does.
enum Theme {

    // MARK: - Status (the one color variable)

    static let cWorking = Color(nsColor: .systemGreen)
    static let cNeeds   = Color(nsColor: .systemOrange)
    static let cReady   = Color(nsColor: .systemTeal)
    static let cError   = Color(nsColor: .systemRed)
    static let cDone    = Color(nsColor: .systemGray)

    static func status(_ s: TaskStatus) -> Color {
        switch s {
        case .processing: return cWorking
        case .needsUser:  return cNeeds
        case .ready:      return cReady
        case .stuck, .failed: return cError
        case .done:       return cDone
        }
    }

    /// Sentence case, not SHOUTED MONOSPACE. The uppercase tracked-out mono
    /// label reads as a developer tool; a Mac app says "Needs you".
    static func statusLabel(_ s: TaskStatus) -> String {
        switch s {
        case .processing: return "Working"
        case .needsUser:  return "Needs you"
        case .ready:      return "Ready"
        case .stuck:      return "Stuck"
        case .failed:     return "Errored"
        case .done:       return "Done"
        }
    }

    // MARK: - The primary action (MONOCHROME, deliberately)
    //
    // Status already owns all four useful hues — green working, orange needs-you,
    // teal ready, red errored. Any accent that is not one of those is blue or
    // violet, and a blue primary sat next to an amber card competed with the one
    // signal this whole surface exists to convey.
    //
    // So the primary action carries NO hue at all: near-white on the dark plane.
    // Colour is 100% reserved for status, which is the R1 rule stated honestly
    // rather than stated and then undercut by the system accent.
    static let accent    = Color.white.opacity(0.93)
    /// Ink ON a primary control — the fill is near-white, so its label is dark.
    static let accentInk = Color(red: 0.06, green: 0.065, blue: 0.08)
    static let accentDim = Color.white.opacity(0.14)
    /// The one exception, and it is not an accent: a pinned star is gold because
    /// that is what a star is.
    static let pinGold   = Color(nsColor: .systemYellow)

    // MARK: - Content layer (opaque; never glass)

    /// The plane that sits inside the glass shell. Deliberately near-opaque:
    /// body text has to stand on solid ground. All translucency is spent on the
    /// shell around it.
    static let plane        = Color(red: 0.086, green: 0.094, blue: 0.110).opacity(0.94)
    /// A raised element ON the plane — cards, buttons, fields.
    static let raised       = Color.white.opacity(0.055)
    static let raisedHover  = Color.white.opacity(0.085)
    /// A recessed element — text fields, the terminal well.
    static let sunken       = Color.black.opacity(0.30)
    static let hairline     = Color.white.opacity(0.10)
    static let hairlineSoft = Color.white.opacity(0.06)
    /// The sidebar wash. Edge-to-edge per Golden Gate — no floating inset.
    static let railBg       = Color.white.opacity(0.028)

    // Legacy aliases, kept so call sites read naturally. Both now resolve to
    // the content-layer tokens above rather than their old hand-mixed values.
    static let fill         = plane
    static let fillElevated = plane
    static let cardBg       = raised

    // MARK: - Ink

    static let text      = Color.white.opacity(0.95)
    static let textDim   = Color.white.opacity(0.62)
    static let textFaint = Color.white.opacity(0.40)

    // MARK: - Geometry (concentric)

    /// Panel corner radius per state. Golden Gate tightened Tahoe's oversized
    /// window corners; these follow. Top corners are always square — the
    /// surface hangs from the screen's top edge (see NotchShape).
    static func radius(for state: NotchState) -> CGFloat {
        switch state {
        case .dormant:            return 5
        case .idle:               return 13
        case .active, .attention: return 15
        case .task, .cockpit:     return panelRadius
        }
    }

    static let panelRadius: CGFloat = 18
    /// Inset from the glass shell to the content plane.
    static let panelPadding: CGFloat = 6
    /// CONCENTRIC: the plane's radius is the panel's minus the padding.
    static var planeRadius: CGFloat { panelRadius - panelPadding }   // 12
    /// Fixed radii for elements that are not corner-adjacent.
    static let cardRadius: CGFloat = 10
    static let controlRadius: CGFloat = 7
    /// Plane edge → content.
    static let gutter: CGFloat = 16

    // MARK: - Motion

    /// Expansion leads with the shape.
    static let morph: Animation    = .spring(response: 0.48, dampingFraction: 0.82)
    /// Collapse is snappier than expansion.
    static let collapse: Animation = .spring(response: 0.32, dampingFraction: 0.88)
    /// Glass light/dark flip.
    static let flip: Animation     = .easeInOut(duration: 0.24)
    /// Hover / press feedback.
    static let hover: Animation    = .easeOut(duration: 0.15)

    // MARK: - Type scale
    //
    // Apple's stated change for the new design system: bolder, left-aligned.
    // Monospace is reserved for GENUINELY TABULAR data — ages, durations,
    // counts, paths — and nothing else.

    static let fTitle   = Font.system(size: 17, weight: .semibold)
    static let fHead    = Font.system(size: 15, weight: .semibold)
    static let fBody    = Font.system(size: 13)
    static let fBodyMed = Font.system(size: 13, weight: .medium)
    static let fSub     = Font.system(size: 12)
    static let fCap     = Font.system(size: 11, weight: .medium)
    static let fStatus  = Font.system(size: 11, weight: .semibold)
    /// Section labels: uppercase, with tracking applied at the call site.
    static let fMicro   = Font.system(size: 10, weight: .semibold)
    static let fNum     = Font.system(size: 10.5, design: .monospaced)
    static let fTerm    = Font.system(size: 11.5, design: .monospaced)
}

// MARK: - Appearance preference

/// How the surface renders its material.
///
/// macOS already owns this preference — System Settings → Accessibility →
/// Display → Reduce Transparency, and on 26+ the global Liquid Glass opacity
/// slider. So the default is FOLLOW SYSTEM and we honour it. The explicit
/// options exist for two reasons a system setting cannot cover: a hand-built
/// pre-26 surface cannot follow the system slider at all, and a persistent
/// always-on-top panel over someone else's work is a reasonable thing to want
/// solid even when the rest of the system is glass.
///
/// An accessibility preference is never SILENTLY overridden: `.system` is the
/// default, and the other two are only ever reached by explicit user choice.
enum SurfaceAppearance: String, Codable {
    case system, glass, solid
}

/// Live material state, recomputed whenever the system preference changes.
final class Appearance: ObservableObject {
    static let shared = Appearance()

    /// The user's choice from unmute Settings.
    @Published var preference: SurfaceAppearance = .system {
        didSet { recompute() }
    }
    /// Resolved: should this surface render translucent right now?
    @Published private(set) var translucent: Bool = true

    private init() {
        recomputeSilently()
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
            object: nil, queue: .main
        ) { [weak self] _ in self?.recompute() }
    }

    private func resolve() -> Bool {
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
        switch preference {
        case .system: return !reduce
        case .glass:  return true
        case .solid:  return false
        }
    }

    private func recomputeSilently() { translucent = resolve() }

    private func recompute() {
        let next = resolve()
        guard next != translucent else { return }
        translucent = next
        NotchLog.log("appearance: preference=\(preference.rawValue) translucent=\(next)")
    }
}
