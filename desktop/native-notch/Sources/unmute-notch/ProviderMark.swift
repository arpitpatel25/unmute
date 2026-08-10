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
    /// The mark's height. Everything else is derived from it, so a caller can
    /// only ever make it bigger or smaller — never lopsided.
    var size: CGFloat = 13

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
            // NO ART YET ⇒ THE MARK WE ALREADY SHIPPED. A coloured dot is what
            // the wall used before, so an absent asset degrades to the previous
            // design rather than to a hole. It is deliberately not a letter or
            // an invented glyph: guessing at someone's brand is how four made-up
            // model ids reached a picker earlier in this same branch.
            Circle()
                .fill(ProviderMarkArt.fallbackColor(backend))
                .frame(width: size * 0.62, height: size * 0.62)
                .frame(width: size, height: size)
        }
    }
}
