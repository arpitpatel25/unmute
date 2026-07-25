import SwiftUI
import AppKit

// The glass lip.
//
// The notch used to be a flat near-black fill inside a UNIFORM white ring, which
// reads as a sticker laid on the screen rather than a surface above it: a real
// edge never has the same brightness at the bottom as at the top, and a real
// surface never has a hard boundary with nothing behind it.
//
// The fix is deliberately NOT "make the whole panel translucent". Body text has
// to sit on solid ground, and a full-height blur went milky-grey over a light
// page and hurt legibility. So the panel stays PITCH BLACK everywhere content
// lives, and becomes glass only in the last `lip` points — the band where the
// bottom corner radius curves away and there is nothing to read anyway.
//
// Four things stack up inside that band, and all four are needed:
//   1. MATERIAL  — a real NSVisualEffectView sampling what is BEHIND the window.
//                  This is the part that makes it glass instead of a colour: the
//                  wallpaper/app underneath genuinely shows through, blurred.
//   2. TINT      — near-opaque black that falls away only across the lip, so the
//                  material is revealed rather than pasted over.
//   3. RIM       — a gradient hairline: bright on the top edge, ~nothing down the
//                  sides, bright again at the lip. Replaces the uniform ring.
//   4. THICKNESS — inner highlights top and bottom so the shape reads as a slab
//                  with an edge, not a hole cut in the screen.
//
// Everything is anchored in POINTS from the bottom, never in fractions of the
// height. The cockpit is ~5x taller than the pill; a fractional lip would be a
// thin line on one and a huge wash on the other (which is exactly what the first
// attempt got wrong).

// MARK: - Material

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
    /// Depth of the glass band, in points from the bottom edge. Tuned against the
    /// cockpit's 26pt corner radius so the glass and the curve resolve together.
    static func lip(for state: NotchState) -> CGFloat {
        switch state {
        case .dormant:            return 0      // hides against the hardware notch
        case .idle:               return 10
        case .active, .attention: return 12
        case .task:               return 20
        case .cockpit:            return 26
        }
    }

    /// Tint alpha at the very bottom edge. Never 0: a fully clear edge loses the
    /// shape entirely against a bright backdrop, and the rim alone can't carry it.
    /// This is THE dial for how glassy the lip reads — lower is more see-through.
    static let edgeAlpha: Double = 0.30
    /// Tint alpha everywhere above the lip. FULLY opaque on purpose: at .985 a
    /// bright window behind still ghosted through at ~1.5%, which is visible on
    /// white and makes the body look grubby rather than deliberate. Content sits
    /// on solid ground; all translucency is spent on the lip.
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
    /// lip that catches it again), almost nothing down the sides. This is the
    /// single biggest departure from the old uniform `white.opacity(0.55)` ring.
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
}

// MARK: - The composed surface

/// The notch's background: material + tint + rim + thickness, clipped to `shape`.
/// Draws nothing above the lip except solid black, so callers can lay content out
/// exactly as before — with one caveat, handled by `Glass.lip`: keep real content
/// out of the bottom `lip` points (NotchView adds it as bottom padding).
struct GlassSurface: View {
    let shape: NotchShape
    let state: NotchState
    /// Attention states tint the rim amber instead of white.
    let rimHighlight: Color
    /// Emphasize the rim (attention ring) without changing its gradient shape.
    let rimWidth: CGFloat

    var body: some View {
        GeometryReader { geo in
            let h = geo.size.height
            let lip = Glass.lip(for: state)
            ZStack {
                // 1 · MATERIAL — the real thing behind the window, revealed only
                //     across the lip. `.hudWindow` is the darkest stock material,
                //     which keeps the glass from going pale over a white page.
                if lip > 0 {
                    VisualEffectBackdrop(material: .hudWindow)
                        .mask(Glass.materialMask(lip: lip, height: h))
                }
                // 2 · TINT — opaque where content lives, falling away at the lip.
                Glass.tint(lip: lip, height: h)
                // 3 · THICKNESS — inner light top and bottom: the shape reads as a
                //     slab with an edge rather than a hole in the screen.
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
            // 4 · RIM — the gradient hairline that replaces the uniform ring.
            .overlay(shape.stroke(Glass.rim(highlight: rimHighlight), lineWidth: rimWidth))
        }
    }
}
