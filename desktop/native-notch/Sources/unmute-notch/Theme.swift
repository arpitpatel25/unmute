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
    /// THE AI FORMATTER (Caps Lock) — a mode, not a status, so its own hue.
    ///
    /// Fn dictates verbatim; Caps Lock runs what you say through the formatter.
    /// The two pills were identical, so there was nothing to tell you which one
    /// you had opened until the text landed.
    ///
    /// Red was the obvious ask and the wrong answer: red is cError, and a mode
    /// used many times a day that reads as a failure teaches the user to ignore
    /// the one colour that means something is genuinely wrong. Indigo belongs to
    /// nothing else here.
    ///
    /// REMOTE IS DELIBERATELY NOT TINTED. It already announces itself — its own
    /// glyph in place of the record dot, plus the agent/model chip beside the
    /// timer. Tinting it too would leave the neutral pill meaning "not one of
    /// the two special modes", which is a weaker signal than "this one is the
    /// formatter".
    static let cInstruction = Color(nsColor: .systemIndigo)

    /// A LINK IN AN AGENT'S PROSE — not a status either, but it has to be
    /// distinguishable from body text at a glance or nobody discovers it is
    /// clickable. `.linkColor` is the system's own answer, so it tracks the
    /// user's accent and their accessibility settings rather than freezing one
    /// blue that may fail contrast for someone.
    static let cLink = Color(nsColor: .linkColor)

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

    // NO `radius(for:)` ANY MORE.
    //
    // The bar-level mass impersonates the hardware cutout, so its bottom radius
    // is a property of the SCREEN, not of the state — it is derived from the
    // measured menu-bar height in NotchGeometry.barCornerRadius. A per-state
    // table here was a second, contradictory source for the same number and it
    // could never match a display it had not been written for.
    //
    // Only the expanded panel still chooses its own radius, and it has exactly
    // one: panelRadius.

    static let panelRadius: CGFloat = 18
    /// The concave fillet at the expanded panel's TOP corners, where it meets
    /// the menu bar. Bar-level fillets are derived from the bar (see
    /// NotchGeometry.barFillet); the panel is not bar-sized, so it names its
    /// own — one number, still part of the same shape path.
    static let panelFillet: CGFloat = 14
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
    //
    /// One native-sized transition for every surface state. AppKit uses this
    /// exact duration for the NSPanel frame; SwiftUI uses it for the matching
    /// state transaction. A gentle system-like ease reads as one surface and is
    /// robust when a new destination arrives mid-transition.
    static let surfaceTransitionDuration: Double = 0.24
    static let morph: Animation = .easeInOut(duration: surfaceTransitionDuration)

    /// Reduce Motion's stand-in: a short cross-fade, no spring, no overshoot.
    static let reducedFade: Animation = .easeInOut(duration: 0.16)

    // ── Content, offset from the container ──
    //
    // Cross-fading in lockstep with the resize looks like two views swapping.
    // The old content leaves BEFORE the shape has finished and the new content
    // arrives after it has committed, so one thing appears to become another.
    static let contentOutDuration: Double = 0.09
    static let contentInDuration:  Double = 0.14
    static let contentInDelay:     Double = 0.08
    static let contentOut: Animation = .easeIn(duration: contentOutDuration)
    static let contentIn:  Animation = .easeOut(duration: contentInDuration).delay(contentInDelay)

    /// Glass light/dark flip.
    static let flip: Animation     = .easeInOut(duration: 0.24)
    /// Hover / press feedback. NOT a size change — this is opacity and fill on
    /// controls, and it is deliberately faster than the spring.
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

// MARK: - Reduce Motion

/// The one gate for "the user asked for less movement".
///
/// Read live rather than cached: macOS posts a workspace notification when it
/// changes, and an animation that started before it flipped is half a second
/// long — there is nothing to invalidate.
enum Motion {
    /// System Settings → Accessibility → Display → Reduce motion.
    static var reduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    /// The curve for any size change: the native frame duration's matching
    /// ease, or a short cross-fade when Reduce Motion is on.
    ///
    /// Content in / out is decided in the view instead, from
    /// `@Environment(\.accessibilityReduceMotion)` — SwiftUI already tracks the
    /// preference there and re-renders when it flips, and a second copy of the
    /// same decision here is how two answers to one question start to diverge.
    static var resize: Animation { reduceMotion ? Theme.reducedFade : Theme.morph }
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
    /// Defaults to `.solid` — the FIXED treatment.
    ///
    /// Live Liquid Glass remains available in Settings, but it is not the
    /// default: on macOS 26.2 its backdrop is cached by the system, so it shows
    /// the previous Space's colours until something behind it repaints, and
    /// every way of forcing a re-sample is visible as a flicker. A surface that
    /// is occasionally wrong, or that blinks on every swipe, is worse than one
    /// that is always exactly itself. Flip the setting back when Apple fixes it.
    @Published var preference: SurfaceAppearance = .solid {
        didSet { recompute() }
    }
    /// Resolved: should this surface render translucent right now?
    @Published private(set) var translucent: Bool = true

    /// Bumped to force every glass surface to be REBUILT from scratch.
    ///
    /// Liquid Glass samples what is behind the window, and macOS refreshes that
    /// sample only when something behind it repaints — never merely because the
    /// Space changed. Land on a live desktop and the widgets and Dock repaint,
    /// so it corrects itself; land on a STATIC full-screen app and it holds the
    /// old Space's colours until the cursor passes over it.
    ///
    /// Apple exposes no way to invalidate a backdrop, because its own
    /// always-present surfaces are composited by the WindowServer rather than
    /// drawn with app-level vibrancy. Rebuilding the view is the closest thing
    /// available: the material is constructed anew and samples afresh.
    @Published private(set) var backdropToken: Int = 0

    /// Called on a Space change / wake. See AppController.refreshBackdrop.
    func invalidateBackdrop() { backdropToken &+= 1 }

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
