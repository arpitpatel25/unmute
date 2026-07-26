import SwiftUI
import AppKit

// THE MATERIAL — two tiers, one design.
//
// Package.swift declares .macOS(.v13). Real Liquid Glass (NSGlassEffectView /
// .glassEffect) needs macOS 26. So the material ships in two tiers that are
// visually continuous — identical geometry, type, colour and motion, differing
// only in how the surface is produced:
//
//   TIER A (macOS 26+)  — the system material. Real lensing: light is BENT and
//                         concentrated rather than scattered. Adapts its tint,
//                         shadow and dynamic range to what is behind it, flips
//                         light/dark on small elements, and follows the user's
//                         global Liquid Glass opacity slider for free.
//
//   TIER B (macOS 13–15) — NSVisualEffectView plus a hand-built rim. Blurs, but
//                         cannot lens and cannot follow the system slider. This
//                         is the original four-layer stack that shipped here,
//                         kept almost unchanged; the reasoning behind it still
//                         holds and it remains the correct floor.
//
// WHY THE BODY IS OPAQUE IN BOTH TIERS. Apple reserves glass for the navigation
// layer floating above content. The small states ARE that layer — nothing sits
// behind them but wallpaper — so they are wholly glass. The large states carry
// real content (a terminal, a transcript, a wall of cards), and content on glass
// is both against the guidance and, measured here first, simply less legible: a
// full-height blur went milky-grey over a light page. So the large states are a
// glass SHELL around an OPAQUE PLANE (Theme.plane), which is exactly how a Mac
// window pairs a glass toolbar with a solid content area.
//
// Tier B anchors everything in POINTS from the bottom, never fractions of the
// height. The cockpit is ~5x taller than the pill; a fractional lip is a thin
// line on one and a huge wash on the other.

// MARK: - Tier B material

/// A live backdrop blur of whatever is behind the window. `.behindWindow`
/// blending is what samples the desktop; `.withinWindow` would only blur our own
/// content and would look like nothing at all here.
struct VisualEffectBackdrop: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .hudWindow

    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = material
        v.blendingMode = .behindWindow
        // Keep sampling while the app is not frontmost — the notch spends most of
        // its life over someone else's active window, and `.followsWindowActiveState`
        // would flatten the glass to grey exactly then.
        v.state = .active
        v.isEmphasized = false
        return v
    }

    func updateNSView(_ v: NSVisualEffectView, context: Context) {
        v.material = material
        v.state = .active
    }
}

// MARK: - Tokens

enum Glass {
    /// Depth of the translucent band, in points from the bottom edge. Tuned
    /// against the panel's corner radius so glass and curve resolve together.
    /// Only meaningful in Tier B — Tier A's shell is uniformly glass because it
    /// never contains content directly.
    static func lip(for state: NotchState) -> CGFloat {
        switch state {
        case .dormant:            return 0      // hides against the hardware notch
        case .idle:               return 10
        case .active, .attention: return 12
        case .task:               return 18
        case .cockpit:            return 22
        }
    }

    /// True when this state is wholly glass (pure chrome, no content of its own).
    /// The large states are a shell around an opaque plane instead.
    static func isChromeOnly(_ state: NotchState) -> Bool {
        switch state {
        case .task, .cockpit: return false
        default:              return true
        }
    }

    /// Tint alpha at the very bottom edge. Never 0: a fully clear edge loses the
    /// shape entirely against a bright backdrop, and the rim alone can't carry it.
    static let edgeAlpha: Double = 0.30
    /// Tint alpha everywhere above the lip. FULLY opaque on purpose: at .985 a
    /// bright window behind still ghosted through at ~1.5%, which is visible on
    /// white and makes the body look grubby rather than deliberate.
    static let bodyAlpha: Double = 1.0

    /// Vertical tint ramp, expressed in points from the bottom so it is identical
    /// on every state. Returns stops for a bottom-anchored gradient.
    static func tint(lip: CGFloat, height: CGFloat) -> LinearGradient {
        // Guard: on a zero/short frame (first layout pass) fall back to solid.
        guard height > 1, lip > 1 else {
            return LinearGradient(colors: [Color.black.opacity(bodyAlpha)], startPoint: .top, endPoint: .bottom)
        }
        let lipFrac = min(max(lip / height, 0), 1)
        return LinearGradient(
            stops: [
                .init(color: Color.black.opacity(bodyAlpha), location: 0),
                .init(color: Color.black.opacity(bodyAlpha), location: 1 - lipFrac),
                .init(color: Color(red: 0.004, green: 0.008, blue: 0.016).opacity(0.86), location: 1 - lipFrac * 0.38),
                .init(color: Color(red: 0.016, green: 0.024, blue: 0.039).opacity(edgeAlpha), location: 1),
            ],
            startPoint: .top, endPoint: .bottom
        )
    }

    /// Mask for the material: fully hidden above the lip, fully shown at the edge.
    /// Without this the blur covers the whole panel and washes the content out.
    static func materialMask(lip: CGFloat, height: CGFloat) -> LinearGradient {
        guard height > 1, lip > 1 else {
            return LinearGradient(colors: [.clear], startPoint: .top, endPoint: .bottom)
        }
        let lipFrac = min(max(lip / height, 0), 1)
        return LinearGradient(
            stops: [
                .init(color: .clear, location: 0),
                .init(color: .clear, location: 1 - lipFrac),
                .init(color: Color.black.opacity(0.55), location: 1 - lipFrac * 0.45),
                .init(color: .black, location: 1),
            ],
            startPoint: .top, endPoint: .bottom
        )
    }

    /// The specular rim. Bright where a light source would land (top edge and the
    /// lip that catches it again), almost nothing down the sides.
    static func rim(highlight: Color = .white) -> LinearGradient {
        LinearGradient(
            stops: [
                .init(color: highlight.opacity(0.55), location: 0.00),
                .init(color: highlight.opacity(0.11), location: 0.12),
                .init(color: highlight.opacity(0.045), location: 0.55),
                .init(color: highlight.opacity(0.13), location: 0.88),
                .init(color: highlight.opacity(0.46), location: 1.00),
            ],
            startPoint: .top, endPoint: .bottom
        )
    }

    /// Drop shadow. Larger states simulate a THICKER material: deeper shadow,
    /// more pronounced separation — Apple's stated behaviour for large glass.
    static func shadowRadius(for state: NotchState) -> CGFloat {
        isChromeOnly(state) ? 14 : 34
    }
    static func shadowY(for state: NotchState) -> CGFloat {
        isChromeOnly(state) ? 4 : 14
    }
    static func shadowOpacity(for state: NotchState) -> Double {
        isChromeOnly(state) ? 0.32 : 0.46
    }
}

// MARK: - The composed surface

/// The notch's background.
///
/// Tier A hands the shape to the system and lets it do the lensing. Tier B
/// composes material + tint + rim + thickness by hand. Both clip to `shape`,
/// carry the same rim hue, and cast the same shadow — so the two tiers are
/// interchangeable at every call site.
struct GlassSurface: View {
    let shape: NotchShape
    let state: NotchState
    /// Attention states tint the rim (and, in Tier A, the material itself).
    let rimHighlight: Color
    /// Emphasize the rim without changing its gradient shape.
    let rimWidth: CGFloat
    /// Tint the whole material — the sanctioned use of tint, for a state that
    /// genuinely needs the user. nil = untinted.
    var tint: Color? = nil

    @ObservedObject private var appearance = Appearance.shared

    var body: some View {
        Group {
            if appearance.translucent {
                if #available(macOS 26.0, *) {
                    tierA
                } else {
                    tierB
                }
            } else {
                // Reduce Transparency / user chose Solid. Apple's own treatment:
                // near-opaque, with the rim brought UP so the shape survives
                // without any material behind it to define it.
                shape.fill(Color(red: 0.07, green: 0.075, blue: 0.09))
                    .overlay(shape.stroke(Color.white.opacity(0.22), lineWidth: max(rimWidth, 1)))
            }
        }
        .shadow(color: .black.opacity(Glass.shadowOpacity(for: state)),
                radius: Glass.shadowRadius(for: state),
                y: Glass.shadowY(for: state))
        .animation(Theme.flip, value: appearance.translucent)
    }

    // ── Tier A · macOS 26+ ────────────────────────────────────────────────

    @available(macOS 26.0, *)
    private var tierA: some View {
        // The system material does the lensing, the adaptive tinting, the
        // light/dark flip and the shadow adaptation. We only choose the shape
        // and (for attention) the tint. Anything we drew on top of this would be
        // glass-on-glass, which cannot sample correctly — so we draw nothing.
        Color.clear
            .glassEffect(glassStyle, in: shape)
    }

    @available(macOS 26.0, *)
    private var glassStyle: Glass26Style {
        // `.regular` is the default for 90%+ of cases: all adaptive effects, and
        // legibility guaranteed regardless of context. `.clear` is only legal
        // over bold, bright, media-rich content — which this surface never has.
        if let tint { return .regular.tint(tint) }
        return .regular
    }

    // ── Tier B · macOS 13–15 ──────────────────────────────────────────────

    private var tierB: some View {
        GeometryReader { geo in
            let h = geo.size.height
            // A shell around an opaque plane has no content of its own to keep
            // legible, so it can be glass for its whole height. A chrome-only
            // state resolves its glass across the lip, as before.
            let lip = Glass.isChromeOnly(state) ? Glass.lip(for: state) : h
            ZStack {
                // 1 · MATERIAL — the real thing behind the window, revealed
                //     across the lip. `.hudWindow` is the darkest stock
                //     material, which keeps the glass from going pale over a
                //     white page.
                if lip > 0 {
                    VisualEffectBackdrop(material: .hudWindow)
                        .mask(Glass.materialMask(lip: lip, height: h))
                }
                // 2 · TINT — opaque where content lives, falling away at the lip.
                Glass.tint(lip: lip, height: h)
                // 2b · ATTENTION TINT — a wash of the status hue across the whole
                //      material, mapped over the tint rather than pasted on top.
                if let tint {
                    tint.opacity(0.22).blendMode(.plusLighter)
                }
                // 3 · THICKNESS — inner light top and bottom: the shape reads as
                //     a slab with an edge rather than a hole in the screen.
                if lip > 0 {
                    shape
                        .stroke(
                            LinearGradient(
                                stops: [
                                    .init(color: .white.opacity(0.20), location: 0),
                                    .init(color: .clear, location: 0.30),
                                    .init(color: .clear, location: 0.80),
                                    .init(color: .white.opacity(0.26), location: 1),
                                ],
                                startPoint: .top, endPoint: .bottom),
                            lineWidth: 1)
                        .blur(radius: 0.5)
                        .blendMode(.plusLighter)
                        .opacity(0.9)
                }
            }
            .clipShape(shape)
            // 4 · RIM — the gradient hairline that replaces a uniform ring.
            .overlay(shape.stroke(Glass.rim(highlight: rimHighlight), lineWidth: rimWidth))
        }
    }
}

// Type alias so the @available-gated style expression stays readable above.
// (Glass is a namespace enum in this file, so the system type is aliased rather
// than referenced bare.)
@available(macOS 26.0, *)
typealias Glass26Style = SwiftUI.Glass
