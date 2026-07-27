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

    /// THE BLACK-GLASS WASH.
    ///
    /// The identity is "black glass", not "grey panel": a near-black tint over a
    /// real behind-window blur, dark enough to own its shape on a white page and
    /// transparent enough that the wallpaper genuinely moves behind it.
    ///
    /// It is NOT opaque. The previous build made the body fully opaque and spent
    /// all its translucency on a 10–26pt lip, which is why the surface read as a
    /// solid slab. The large states can afford to be opaque *inside* — but that
    /// is the content PLANE's job (Theme.plane), not the shell's.
    static func bodyTint(for state: NotchState) -> LinearGradient {
        // Large surfaces simulate a THICKER material: deeper tint, less of the
        // backdrop through it. Apple's stated behaviour for large glass.
        let top: Double    = isChromeOnly(state) ? 0.64 : 0.72
        let bottom: Double = isChromeOnly(state) ? 0.44 : 0.58
        let ink = Color(red: 0.016, green: 0.020, blue: 0.030)
        return LinearGradient(
            stops: [
                .init(color: ink.opacity(top), location: 0),
                .init(color: ink.opacity(top), location: 0.5),
                // The lip: the band where the corner curves away and there is
                // nothing to read, so it can be the most transparent part.
                .init(color: ink.opacity(bottom), location: 1),
            ],
            startPoint: .top, endPoint: .bottom
        )
    }

    /// How strongly a status hue washes the material.
    ///
    /// LOW ON PURPOSE. Apple's adaptive tinting maps a tone range against the
    /// backdrop it samples; ours has no such feedback, so a full-strength tint
    /// renders as flat saturated colour. At attention size that was merely loud;
    /// mid-morph, with the window already resized to the task frame, it was a
    /// full-screen orange rectangle.
    static let statusWashAlpha: Double = 0.22

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
/// TIER A (macOS 26+) IS APPLE'S REAL LIQUID GLASS. An earlier build claimed
/// `.glassEffect` "samples content within the window" and therefore could not
/// work in a floating panel. THAT WAS WRONG, and a standalone probe against
/// this exact window configuration disproved it: the desktop is genuinely
/// visible through it and it lenses at its own edge.
///
/// What actually produced the flat grey was wrapping the glass in `.shadow()`.
/// A shadow forces offscreen rasterisation, and a rasterised layer has no
/// backdrop left to sample. One misread observation became a commit message
/// stated as fact, and an entire hand-built material was built on top of it.
///
/// The rim is an OVERLAY STROKE, not a second material — Apple's prohibition is
/// on stacking glass ON glass, and a stroke is explicitly the correct way to
/// put something on top of it. Apple's own rim is subtle over a dark backdrop;
/// ours restores the definition the surface is designed around.
///
/// TIER B (macOS 13–15) composes the material by hand and remains a genuine
/// floor. It blurs but cannot lens, and cannot follow the user's system Liquid
/// Glass opacity slider.
struct GlassSurface: View {
    let shape: NotchShape
    let state: NotchState
    /// Attention tints the rim as well as the material.
    let rimHighlight: Color
    /// Emphasize the rim without changing its gradient shape.
    let rimWidth: CGFloat
    /// Wash the material in a status hue — the sanctioned use of tint, for a
    /// state that genuinely needs the user. nil = untinted.
    var tint: Color? = nil

    @ObservedObject private var appearance = Appearance.shared

    var body: some View {
        Group {
            if appearance.translucent {
                if #available(macOS 26.0, *) {
                    // REAL LIQUID GLASS. Verified against this exact window
                    // configuration — a non-activating borderless panel over
                    // other apps — with a standalone probe: the desktop is
                    // genuinely visible through it, and it lenses at its own
                    // edge rather than merely blurring.
                    //
                    // NEVER WRAP THIS IN .shadow(). A shadow forces offscreen
                    // rasterisation, and a rasterised layer has no backdrop to
                    // sample — which is why the first attempt rendered a flat
                    // neutral grey and why I wrongly concluded the API could not
                    // work here at all. The rim below is an OVERLAY STROKE, not
                    // a second material, so it composes legally: Apple's
                    // prohibition is on stacking glass ON glass.
                    Color.clear.glassEffect(glassStyle, in: shape)
                } else {
                    tierB
                }
            } else {
                // Reduce Transparency, or the user chose Solid.
                ZStack {
                    Color(red: 0.055, green: 0.06, blue: 0.075)
                    if let tint { tint.opacity(0.14) }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipShape(shape)
        .contentShape(shape)
        // The specular rim: bright top edge, almost nothing down the sides,
        // bright again at the lip. Apple's own rim is subtle on a dark backdrop;
        // this restores the definition the surface is designed around.
        .overlay(shape.stroke(Glass.rim(highlight: rimHighlight),
                              lineWidth: appearance.translucent ? rimWidth : max(rimWidth, 1)))
        .animation(Theme.flip, value: appearance.translucent)
    }

    @available(macOS 26.0, *)
    private var glassStyle: Glass26Style {
        // `.regular` — all adaptive effects, legibility guaranteed in any
        // context. Attention passes its status hue through Apple's tinting,
        // which maps a tone range against the backdrop instead of pasting a
        // flat wash on top.
        if let tint { return .regular.tint(tint.opacity(0.55)) }
        return .regular
    }

    /// macOS 13–15: no Liquid Glass, so the material is composed by hand —
    /// behind-window sampler, near-black wash, thickness. This is a genuine
    /// floor, not the design.
    private var tierB: some View {
        ZStack {
                VisualEffectBackdrop(material: .hudWindow)

                // 2 · TINT — a near-black wash that carries the "black glass"
                //     identity while leaving the wallpaper genuinely visible
                //     through it. Deeper on the large surfaces, which simulate a
                //     thicker material.
                Glass.bodyTint(for: state)

                // 3 · STATUS WASH — low alpha on purpose. At full strength an
                //     unmodulated tint renders as flat saturated colour (the
                //     orange-flash bug); Apple's adaptive tinting has a backdrop
                //     to map against, ours does not, so we keep it a wash.
                //     Never animated: it must switch with the state, not fade
                //     across a frame change.
                if let tint {
                    tint.opacity(Glass.statusWashAlpha).blendMode(.softLight)
                    tint.opacity(Glass.statusWashAlpha * 0.5)
                }

                // 4 · THICKNESS — inner light top and bottom, so the shape reads
                //     as a slab with an edge rather than a hole in the screen.
                shape
                    .stroke(
                        LinearGradient(
                            stops: [
                                .init(color: .white.opacity(0.22), location: 0),
                                .init(color: .clear, location: 0.28),
                                .init(color: .clear, location: 0.82),
                                .init(color: .white.opacity(0.28), location: 1),
                            ],
                            startPoint: .top, endPoint: .bottom),
                        lineWidth: 1)
                    .blur(radius: 0.5)
                    .blendMode(.plusLighter)
                    .opacity(0.9)
        }
    }
}

// The system glass style type. `Glass` is a namespace enum in this file, so the
// SwiftUI type is aliased rather than referenced bare.
@available(macOS 26.0, *)
typealias Glass26Style = SwiftUI.Glass
