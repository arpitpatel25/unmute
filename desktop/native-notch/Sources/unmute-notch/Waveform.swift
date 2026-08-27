import SwiftUI
import LevelMeterSupport

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
    // 20 bars at 2/2 measure 78pt — a little longer than the 70 it replaces,
    // and finer, so the shape reads as a voice rather than a row of blocks.
    var bars: Int = 20
    // 14 was most of the reason this looked dead: even a shout only filled 14
    // points. 16 is what a 36pt capsule can give while keeping 10pt of air.
    var height: CGFloat = 16
    var barWidth: CGFloat = 2
    var spacing: CGFloat = 2
    var color: Color = Theme.text

    @State private var history: [Double] = []
    /// The smoothed level the last frame settled on. See `push`.
    @State private var envelope: Double = 0

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

    /// The arithmetic lives in `LevelMeterSupport` so it can be tested; see
    /// there for why every constant is fixed rather than adaptive.
    private func push(_ v: Double) {
        envelope = LevelMeter.advance(envelope, toward: LevelMeter.target(for: v))
        var h = history
        h.append(envelope)
        if h.count > bars { h.removeFirst(h.count - bars) }
        history = h
    }
}

/// "YOUR VOICE IS GOING HERE" — the live-aim chip.
///
/// Shown on the pocket card and on an expanded task while a REMOTE capture is
/// running. It is deliberately not shown for ordinary dictation: that text goes
/// to whatever you were typing in, not to a task, and a mic on the card would
/// claim otherwise.
///
/// The distinction it buys is the one worth having — when this is absent while
/// you speak, the words are going to the router to become a NEW task. Present,
/// and they are going to the card you can see.
///
/// One chip rather than a loose mic and a loose waveform: the two together are
/// a single statement, and drawn separately they read as two unrelated
/// ornaments in a row that already has several.
struct AimedChip: View {
    let level: Double
    var compact: Bool = false

    var body: some View {
        HStack(spacing: compact ? 5 : 6) {
            Image(systemName: "mic.fill")
                .font(.system(size: compact ? 8.5 : 9.5, weight: .semibold))
                .foregroundColor(Theme.cError)
            Waveform(level: level,
                     bars: compact ? 12 : 16,
                     height: compact ? 9 : 11,
                     barWidth: 1.5, spacing: 1.5,
                     color: Theme.text)
        }
        .padding(.horizontal, compact ? 7 : 8)
        .padding(.vertical, compact ? 3 : 4)
        .background(
            Capsule().fill(Theme.cError.opacity(0.12))
        )
        .overlay(
            // A hairline in the same hue, so the chip reads as lit rather than
            // as a grey pill that happens to contain a red glyph.
            Capsule().stroke(Theme.cError.opacity(0.35), lineWidth: 0.5)
        )
        .accessibilityElement()
        .accessibilityLabel("Listening — your voice goes to this task")
    }
}
