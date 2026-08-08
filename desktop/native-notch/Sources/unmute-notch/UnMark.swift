import SwiftUI

/// THE MARK — the real `un`, rendered from the actual logo.
///
/// This used to draw the mark with `Canvas` and `Path`, from a description
/// rather than from the file. That was wrong in the way guesses usually are:
/// recognisable enough to pass and wrong in every particular — lighter stroke,
/// a shallower bowl on the `u`, and the two signal arcs swept around the `n`'s
/// shoulder rather than standing off its top right. It read as our logo to
/// nobody who knows our logo.
///
/// The artwork now comes from [UnMarkArt], which carries the icon's own pixels
/// (see that file for why they are embedded rather than bundled). Its colours
/// are the brand's — a near-white `un`, violet arcs — and they are deliberately
/// NOT retinted here. This is identity, not a status indicator: it must look
/// the same wherever it appears, and a theme change must not restyle it.
///
/// The bar renders it at ~13pt tall; the source is 126x78, so there is room to
/// spare at any scale factor.
struct UnMark: View {
    /// Cap height. The bar passes ~13; the mark sizes itself from this.
    var height: CGFloat = 13

    /// Width the mark needs, so BarContent can size the mass without guessing.
    /// One trailing point of air, as before, so it never sits flush against the
    /// text beside it.
    static func width(for height: CGFloat) -> CGFloat {
        (height * UnMarkArt.aspect) + 2
    }

    var body: some View {
        Group {
            if let nsImage = NSImage(data: UnMarkArt.png) {
                Image(nsImage: nsImage)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
            } else {
                // Should be unreachable — the bytes are compiled in. Empty
                // rather than a placeholder glyph: a wrong mark is worse than
                // no mark, which is the whole lesson of this file.
                Color.clear
            }
        }
        .frame(width: height * UnMarkArt.aspect, height: height)
        .padding(.trailing, 2)
        .accessibilityLabel("Unmute")
    }
}
