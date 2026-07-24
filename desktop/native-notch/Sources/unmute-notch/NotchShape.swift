import SwiftUI

// The shape that makes the surface read as the NOTCH — not a floating pill.
//
// Per the spec: top corners stay square (flush to the screen's top edge), only
// the bottom corners round, and CONCAVE fillets at the top outer edges make it
// look like the surface flares out of a notch cut into the top of the screen.
// Drawn as an explicit path (never `.cornerRadius()`), so the top shoulders can
// curve the "wrong" way (concave) — the detail that sells the illusion.
struct NotchShape: Shape {
    var bottomRadius: CGFloat
    var shoulder: CGFloat   // concave fillet radius at the top-outer corners

    // Animate both as the surface morphs.
    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(bottomRadius, shoulder) }
        set { bottomRadius = newValue.first; shoulder = newValue.second }
    }

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let br = min(bottomRadius, rect.width / 2, rect.height)
        let s = min(shoulder, rect.width / 2, rect.height)

        // Start just below the top-left, after the concave shoulder.
        p.move(to: CGPoint(x: rect.minX, y: rect.minY + s))
        // Concave top-left shoulder: curve OUTWARD/UP toward the top edge, so the
        // body appears to flare down from a narrower neck at the very top.
        p.addQuadCurve(to: CGPoint(x: rect.minX + s, y: rect.minY),
                       control: CGPoint(x: rect.minX + s, y: rect.minY + s))
        // Flat top edge (flush with the screen top).
        p.addLine(to: CGPoint(x: rect.maxX - s, y: rect.minY))
        // Concave top-right shoulder.
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + s),
                       control: CGPoint(x: rect.maxX - s, y: rect.minY + s))
        // Right edge down to the bottom-right round.
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - br))
        p.addQuadCurve(to: CGPoint(x: rect.maxX - br, y: rect.maxY),
                       control: CGPoint(x: rect.maxX, y: rect.maxY))
        // Bottom edge.
        p.addLine(to: CGPoint(x: rect.minX + br, y: rect.maxY))
        p.addQuadCurve(to: CGPoint(x: rect.minX, y: rect.maxY - br),
                       control: CGPoint(x: rect.minX, y: rect.maxY))
        p.closeSubpath()
        return p
    }
}
