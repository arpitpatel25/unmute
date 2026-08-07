import SwiftUI

/// THE MARK — "un" plus its signal, drawn rather than shipped.
///
/// This replaces the word "unmute" set in light type, which is what idle used
/// to show. A wordmark at 9.5pt on a black bar is just small grey text: it
/// reads as a label, not as us, and it was the least identifiable thing on
/// screen at exactly the moment the surface has nothing else to say.
///
/// DRAWN, NOT BUNDLED, and that is not a preference. The build copies only the
/// helper BINARY into the app (`vendor/unmute-notch/unmute-notch` in
/// wire-into-engine.sh) — a SwiftPM resource bundle would not travel with it,
/// so an image asset would resolve in `swift run` and be missing in the
/// packaged app. Paths have no such problem: they cost nothing, stay crisp at
/// any size, and take the surface's own ink colour.
///
/// Geometry is expressed against a 26 × 15 design box and scaled, so the one
/// place to change proportions is here.
struct UnMark: View {
    /// Cap height. The bar passes ~13; the mark sizes itself from this.
    var height: CGFloat = 13
    var ink: Color = Theme.text
    /// The brand violet, stated here rather than borrowed from the status
    /// palette: this is identity, not a state, and it must not shift if the
    /// instruction hue is ever retuned.
    static let brand = Color(red: 0.545, green: 0.361, blue: 0.965)   // #8B5CF6
    var accent: Color = UnMark.brand

    /// Width the mark needs, so BarContent can size the mass without guessing.
    static func width(for height: CGFloat) -> CGFloat {
        let s = height / 15
        return (26 + 2) * s
    }

    var body: some View {
        Canvas { ctx, _ in
            let s = height / 15
            let lw = 3.0 * s
            let r = lw / 2
            let top = r, bot = height - r
            let stroke = StrokeStyle(lineWidth: lw, lineCap: .round, lineJoin: .round)

            // u — two stems joined by a bottom bowl.
            let uL = r, uR = uL + 7.4 * s, uMid = bot - 3.4 * s
            var u = Path()
            u.move(to: CGPoint(x: uL, y: top))
            u.addLine(to: CGPoint(x: uL, y: uMid))
            u.addArc(center: CGPoint(x: (uL + uR) / 2, y: uMid), radius: (uR - uL) / 2,
                     startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
            u.addLine(to: CGPoint(x: uR, y: top))
            ctx.stroke(u, with: .color(ink), style: stroke)

            // n — the same shape inverted: stems joined by a shoulder on top.
            let nL = uR + 4.2 * s, nR = nL + 7.4 * s, nMid = top + 3.4 * s
            var n = Path()
            n.move(to: CGPoint(x: nL, y: bot))
            n.addLine(to: CGPoint(x: nL, y: nMid))
            n.addArc(center: CGPoint(x: (nL + nR) / 2, y: nMid), radius: (nR - nL) / 2,
                     startAngle: .degrees(180), endAngle: .degrees(0), clockwise: true)
            n.addLine(to: CGPoint(x: nR, y: bot))
            ctx.stroke(n, with: .color(ink), style: stroke)

            // The signal — two concentric arcs off the n's shoulder, and the one
            // piece of colour in the whole resting surface. Centred ON the
            // shoulder and opening up-and-right; swept any wider and they cut
            // across the n itself.
            let cx = nR - 0.6 * s, cy = nMid + 1.6 * s
            let waveStroke = StrokeStyle(lineWidth: lw * 0.62, lineCap: .round)
            for rad in [3.5 * s, 6.3 * s] {
                var a = Path()
                a.addArc(center: CGPoint(x: cx, y: cy), radius: rad,
                         startAngle: .degrees(-108), endAngle: .degrees(-3.6), clockwise: false)
                ctx.stroke(a, with: .color(accent), style: waveStroke)
            }
        }
        .frame(width: Self.width(for: height), height: height)
        .accessibilityLabel("Unmute")
    }
}
