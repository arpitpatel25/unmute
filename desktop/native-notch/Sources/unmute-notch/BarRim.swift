import SwiftUI

// WHERE THE SURFACE ENDS, ON A MENU BAR THAT IS ALSO BLACK.
//
// The mass is opaque black by decision D5, and on a black menu bar that leaves
// it with no visible edge whatsoever. The only cue at rest is the pointer
// turning into a hand — which you only get once you are already inside the
// target, so it answers "am I on it" and never "where is it".
//
// A rim fixes that, but it may NOT be a rim around the mass. From NotchView:
// "there is NO rim on the bar-level mass — a stroke around it would outline the
// black against the housing and put back the join by another route." That
// objection is about the MIDDLE, where the mass crosses the camera housing and
// the two blacks have to be one black. It says nothing about the outer ends,
// which are nowhere near the hardware and are exactly the edges nobody can find.
//
// So the line traces the same geometry NotchShape does — the concave top
// fillet, the wall, the convex bottom corner — and its bottom is ONE STRAIGHT
// RUN from end to end, a few points below the menu bar.
//
// WHY IT IS LOWER, and it is not a taste decision. The camera housing is
// hardware and the pixels behind it are not displayed — the same fact that lets
// the shape be drawn straight through the cutout. A line on the mass's own
// floor is therefore still INSIDE the housing across the middle third and
// simply is not there. Lower is the only place a continuous bottom edge can be
// seen from end to end.
//
// Three earlier shapes were wrong, each teaching the next. Stopping the line
// either side of the housing left two hooks facing each other across a gap,
// which reads as two objects rather than the edge of one. Dipping only the
// middle joined them up but put two kinks in the bottom. Putting the whole line
// back on the mass's floor made it flush with the menu bar and invisible for a
// third of its length.
//
// The room below the bar is the line's alone: the mass is pinned to menu-bar
// height (NotchView.massPlane), because a black lip below the menu bar would
// read as the whole surface sitting low — and would only show in apps that are
// not fullscreen, where there is a menu bar to be out of line with.
//
// See docs/superpowers/specs/steps/hover-edge.html.
struct BarRim: Shape {
    var placement: MassPlacement

    /// The one y the bottom of the line has, anywhere along its width.
    ///
    /// DERIVED FROM THE RECT, never from the placement's own numbers. The view
    /// insets the rim by half a stroke width so the whole stroke stays on
    /// screen, which shrinks the rect; an absolute y would have fallen outside
    /// it and been clipped away — which is exactly how an earlier version lost
    /// its entire middle section.
    static func floorY(in rect: CGRect, _ m: MassPlacement) -> CGFloat { rect.maxY }

    /// A mass with no shoulders is the collapse animation's last frame. It must
    /// degenerate to nothing rather than leave a line lying in the cutout.
    private var draws: Bool { placement.left > 0 || placement.right > 0 }

    func path(in rect: CGRect) -> Path {
        var p = Path()
        guard draws else { return p }
        // Resolved exactly as NotchShape resolves them, so the line sits ON the
        // silhouette rather than near it. Duplicating the clamp would be the
        // overlay bug the shape's own notes warn about: the line and the mass
        // parting company mid-resize, which is when the eye is tracking them.
        let f = max(min(placement.fillet, rect.width / 2, rect.height), 0)
        let body = rect.insetBy(dx: f, dy: 0)
        let floor = Self.floorY(in: rect, placement)
        let br = max(min(placement.bottomRadius, body.width / 2,
                         max(floor - rect.minY - f, 0)), 0)

        // Top-left, out on the menu bar, then the concave flare inward and down.
        p.move(to: CGPoint(x: rect.minX, y: rect.minY))
        p.addQuadCurve(to: CGPoint(x: body.minX, y: rect.minY + f),
                       control: CGPoint(x: body.minX, y: rect.minY))
        p.addLine(to: CGPoint(x: body.minX, y: floor - br))
        p.addArc(tangent1End: CGPoint(x: body.minX, y: floor),
                 tangent2End: CGPoint(x: body.minX + br, y: floor),
                 radius: br)
        // ONE STRAIGHT RUN, straight under the housing and out the other side.
        p.addLine(to: CGPoint(x: body.maxX - br, y: floor))
        p.addArc(tangent1End: CGPoint(x: body.maxX, y: floor),
                 tangent2End: CGPoint(x: body.maxX, y: floor - br),
                 radius: br)
        p.addLine(to: CGPoint(x: body.maxX, y: rect.minY + f))
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY),
                       control: CGPoint(x: body.maxX, y: rect.minY))
        return p
    }
}
