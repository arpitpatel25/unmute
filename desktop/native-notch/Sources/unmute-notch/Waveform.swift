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
/// look like proof of something it is not checking. Level 0 draws a straight,
/// still row, deliberately.
///
/// A ROW THAT VIBRATES IN PLACE, not a scrolling history. An earlier revision
/// kept the last N levels and shifted them left, which put the loudest motion
/// in the frame on the horizontal axis: under the notch, beside a cursor that
/// is also moving, the eye tracked the drift instead of reading the shape, and
/// the strip read as a second thing scrolling. NOTHING MOVES SIDEWAYS, and the
/// count is fixed — loudness is spent on how tall the bars are, never on how
/// many there are, so the capsule's width is constant for a whole dictation.
///
/// BARS WITH HEIGHTS, NOT DOTS WITH POSITIONS. The revision before this one
/// drew dots displaced from a centre line. Every dot travelled the same
/// distance, so the row rose and fell as one rigid string: no dot was ever
/// taller than its neighbour, and loud and quiet were the same picture at a
/// different altitude. The reported symptom was exactly that — "the length
/// doesn't increase, it just waves". Each slot now owns a HEIGHT, the heights
/// differ across the row, and the shape itself changes. See `DotWave.barHeight`.
struct Waveform: View {
    /// 0…1, as the engine reports it.
    let level: Double
    /// FIXED FOR THE LIFE OF THE ROW. Eleven reads as a meter rather than as a
    /// handful of marks, and still leaves each bar wide enough to watch. This
    /// is a slot count, not a budget that grows with volume.
    var bars: Int = 11
    /// The band the bars stand in. 16 is what a 36pt capsule gives while
    /// keeping 10pt of air.
    var height: CGFloat = 16
    /// A BAR IS A CAPSULE, so this is both its width and its corner diameter —
    /// at the floor height the bar is exactly a dot, which is what silence
    /// should look like.
    var barWidth: CGFloat = 3
    var spacing: CGFloat = 2.5
    /// PURE WHITE, AND NOTHING BUT. Not Theme.text (0.95), and not modulated.
    ///
    /// Two separate dimmings used to stack here: callers passed `Theme.text`,
    /// and the fill then multiplied it by an envelope-driven opacity ramp. A
    /// shout peaked at 0.95 and an ordinary speaking level landed near 0.64, so
    /// the row read grey at exactly the moment it was working hardest, and the
    /// silent row read greyer still.
    ///
    /// COLOUR NO LONGER CARRIES LEVEL — the HEIGHTS do, which is the entire
    /// point of the bar row. Two channels for one quantity meant a loud moment
    /// was announced twice and a quiet one was punished twice; the brightness
    /// channel is spent, and the bars are the same white whatever the mic
    /// hears. The capsule is pitch black and this is the only thing in it.
    var color: Color = .white

    @State private var envelope: Double = 0

    /// The height a bar holds when the mic hears nothing. Equal to the width,
    /// so a silent row is a row of dots — the same still, flat statement the
    /// dot row made, kept deliberately.
    private var floorHeight: CGFloat { barWidth }

    /// RESPONSE CURVE, and the reason it is here rather than in `DotWave`.
    ///
    /// `LevelMeter`'s envelope is linear in the engine's reported level, and
    /// ordinary speech spends most of its time in the bottom third of that
    /// range — which is why the row read as "not very responsive" even though
    /// it was tracking the mic correctly. A gamma below 1 spends more of the
    /// bar's travel on the levels a voice actually occupies. It is a DISPLAY
    /// curve, not a measurement change: 0 still maps to 0, so the silence
    /// contract is untouched, and 1 still maps to 1, so a shout cannot clip.
    private var responsive: Double { envelope <= 0 ? 0 : pow(envelope, 0.62) }

    var body: some View {
        // ONE CLOCK FOR THE WHOLE ROW, and none at all while it is silent.
        //
        // `paused` is not an optimisation detail — it is the contract. With the
        // envelope at zero there is nothing to redraw, so a muted mic costs no
        // frames and, more to the point, CANNOT move: the still row is the
        // state the view rests in rather than a shape it happens to be drawing.
        TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: envelope <= 0)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            let amp = responsive
            HStack(alignment: .center, spacing: spacing) {
                ForEach(0..<bars, id: \.self) { i in
                    let h = DotWave.barHeight(index: i, count: bars, time: t, amplitude: amp)
                    Capsule()
                        // FLAT WHITE. No opacity ramp: see `color` above — the
                        // heights are the level, and a second channel saying
                        // the same thing only made the row grey.
                        .fill(color)
                        .frame(width: barWidth,
                               height: floorHeight + CGFloat(h) * (height - floorHeight))
                }
            }
            // The row is centred, so a bar grows from the middle out in both
            // directions. Growing from the baseline would make the strip read
            // as a bar chart sitting on a shelf; a waveform has no shelf.
            .frame(height: height)
        }
        .frame(height: height)
        // The single-argument form: the package targets macOS 13, where the
        // two-argument `onChange` does not exist yet.
        .onChange(of: level) { new in push(new) }
        .accessibilityHidden(true)   // the phase label already speaks
    }

    /// The arithmetic lives in `LevelMeterSupport` so it can be tested; see
    /// there for why every constant is fixed rather than adaptive. The envelope
    /// is unchanged by the redesign — the same smoothed level that used to set
    /// a dot's displacement now sets the row's amplitude, so the surface reacts
    /// to a voice exactly as it did before, only legibly.
    private func push(_ v: Double) {
        envelope = LevelMeter.advance(envelope, toward: LevelMeter.target(for: v))
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
            // Fewer bars and a shorter band than the pill: the chip is an
            // inline mark in a crowded row, so it carries the bottom of the
            // range rather than the middle. Same shape, smaller instrument.
            Waveform(level: level,
                     bars: compact ? 7 : 9,
                     height: compact ? 9 : 11,
                     barWidth: compact ? 2 : 2.5, spacing: compact ? 1.5 : 2)
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
