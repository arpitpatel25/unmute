import SwiftUI

/// WHICH BACKEND RAN THIS, AS A MARK RATHER THAN A SENTENCE.
///
/// Every surface used to spell it out — "Codex CLI", "Claude Code CLI" — in a
/// row that already carries a title, a directory, an age and a model. Four
/// words of chrome repeated on every card, saying something a logo says at a
/// glance.
///
/// ONE COMPONENT, EVERY SURFACE. The pocket, the expansion, the dashboard grid
/// and an opened dashboard card all call this. They had four different ways of
/// showing the same fact (a text label, a coloured square, nothing at all), and
/// the pocket — the surface seen most — showed nothing, so the one place you
/// live in never said what a task runs on.
///
/// THE TERMINAL GLYPH IS A CAPABILITY, NOT A NAME. It follows `terminal` from
/// the provider registry, so a CLI backend added later gets it with no edit
/// here — and a desktop backend never claims a terminal it does not have.
struct ProviderMark: View {
    /// Registry id: "claude" | "codex" | "codex-desktop" | "claude-code-desktop".
    let backend: String?
    /// Does this backend own a terminal? Drives the glyph.
    let terminal: Bool
    /// ONE SIZE, EVERYWHERE. Call sites drifted to 12 in the denser rows and 13
    /// in the headers, which is exactly how a mark stops reading as the same
    /// mark: the eye compares them across surfaces, and a point of difference
    /// looks like a different asset rather than a smaller one.
    ///
    /// A caller may still override — the panel that shows a mark at 15pt as a
    /// fact's value has a reason — but nothing should pass 12 or 13 by hand.
    static let standard: CGFloat = 13
    /// The mark's height. Everything else derives from it, so a caller can only
    /// make it bigger or smaller — never lopsided.
    var size: CGFloat = ProviderMark.standard

    var body: some View {
        HStack(spacing: size * 0.31) {
            vendor
            if terminal {
                // Codex's own CLI and Claude's own CLI look identical at 13pt
                // once they are just two round marks. The glyph is what says
                // "this one has a terminal you can open".
                Image(systemName: "terminal")
                    .font(.system(size: size * 0.78, weight: .medium))
                    .foregroundColor(Theme.textFaint)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement()
        .accessibilityLabel(ProviderMarkArt.name(backend) + (terminal ? ", terminal" : ""))
        .help(ProviderMarkArt.name(backend) + (terminal ? " · has a terminal" : ""))
    }

    @ViewBuilder private var vendor: some View {
        if let art = ProviderMarkArt.image(backend) {
            // SIZED BY ITS INK, NOT BY ITS FILE. Two logos almost never share
            // the same internal padding, so fitting both to one box leaves one
            // visibly smaller. `trim` is measured per logo (see
            // ProviderMarkArt) and scales the image so the MARKS match, which
            // is what the eye compares.
            Image(nsImage: art.image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(width: size * art.scale, height: size * art.scale)
                .frame(width: size, height: size)   // a common box, so rows align
        } else {
            // NO ART YET ⇒ THE NAME. Not a dot.
            //
            // The first version fell back to a coloured dot, on the reasoning
            // that it was "the design the wall already used". That was true of
            // the RENDERER, which drew a small square beside the text — it was
            // never true here, where the label was plain words. So this replaced
            // "Codex CLI" with a dot that says nothing, sitting beside the
            // status dot that was already in the row: two dots, no information,
            // strictly worse than the text it removed.
            //
            // A missing logo means we cannot show the mark. It does not mean we
            // cannot say which backend it is — and the whole point of the change
            // was to make that fact MORE legible, not less.
            Text(ProviderMarkArt.shortName(backend))
                .font(.system(size: size * 0.82, weight: .medium))
                .foregroundColor(Theme.textDim)
                .fixedSize()
        }
    }
}
