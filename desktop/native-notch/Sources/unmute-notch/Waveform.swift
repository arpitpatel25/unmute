import SwiftUI

/// WHAT THE MIC IS HEARING, as a shape rather than a number.
///
/// Replaces the elapsed timer on the capture surfaces. A timer answers "how
/// long have I been talking", which nobody asks; the question people actually
/// have mid-sentence is "is it hearing me" — and a count of seconds ticking up
/// answers that identically whether the mic is live or dead.
///
/// FLAT MEANS SILENT, and that is the whole contract. A decorative animation
/// that wobbles regardless would be worse than the timer it replaces: it would
/// look like proof of something it is not checking. Level 0 draws a straight
/// line, deliberately.
///
/// A SCROLLING HISTORY, not a bar meter. The level arrives per frame from the
/// engine (`pill:level`); keeping the last N and shifting left gives the last
/// second or so of speech at a glance, so a pause reads as a dip in a line
/// rather than as a bar that happens to be short right now.
struct Waveform: View {
    /// 0…1, as the engine reports it.
    let level: Double
    var bars: Int = 18
    var height: CGFloat = 14
    var barWidth: CGFloat = 2
    var spacing: CGFloat = 2
    var color: Color = Theme.text

    @State private var history: [Double] = []

    var body: some View {
        HStack(alignment: .center, spacing: spacing) {
            ForEach(Array(padded.enumerated()), id: \.offset) { _, v in
                Capsule()
                    .fill(color.opacity(0.35 + 0.65 * v))
                    // A FLOOR OF ONE PIXEL, so silence is a line and not a gap.
                    // Zero-height capsules disappear, and a waveform with holes
                    // in it reads as broken rather than quiet.
                    .frame(width: barWidth, height: max(1, CGFloat(v) * height))
            }
        }
        .frame(height: height)
        .animation(.linear(duration: 0.08), value: history)
        // The single-argument form: the package targets macOS 13, where the
        // two-argument `onChange` does not exist yet.
        .onChange(of: level) { new in push(new) }
        .onAppear { history = Array(repeating: 0, count: bars) }
        .accessibilityHidden(true)   // the phase label already speaks
    }

    /// Newest on the right, so it reads the way speech is written.
    private var padded: [Double] {
        let h = history.suffix(bars)
        return Array(repeating: 0, count: max(0, bars - h.count)) + h
    }

    private func push(_ v: Double) {
        // SHAPED, NOT RAW. Mic level is roughly logarithmic in loudness, so a
        // linear mapping leaves ordinary speech in the bottom fifth of the
        // height and only shouting moves it. The square root spends the range
        // where a voice actually lives.
        let shaped = min(1, max(0, v)).squareRoot()
        var h = history
        h.append(shaped)
        if h.count > bars { h.removeFirst(h.count - bars) }
        history = h
    }
}
