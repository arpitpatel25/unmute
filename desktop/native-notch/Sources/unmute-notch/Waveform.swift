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
/// A ROW THAT VIBRATES IN PLACE, not a scrolling history. The previous revision
/// kept the last N levels and shifted them left, which put the loudest motion
/// in the frame on the horizontal axis: under the notch, beside a cursor that
/// is also moving, the eye tracked the drift instead of reading the shape, and
/// the strip read as a second thing scrolling. Nothing moves sideways now. A
/// handful of dots hold their positions and only rise and fall, together, on
/// one clock — see `DotWave` for why that reads as a single vibrating string
/// rather than as a line of independent bouncers.
struct Waveform: View {
    /// 0…1, as the engine reports it.
    let level: Double
    /// Seven is the middle of the five-to-ten range this is drawn for: enough
    /// dots for the standing pattern to be legible as a wave, few enough that
    /// each one is an object you can watch rather than a texture.
    var dots: Int = 7
    /// The band the dots travel in. 16 is what a 36pt capsule can give while
    /// keeping 10pt of air.
    var height: CGFloat = 16
    var dotSize: CGFloat = 3.5
    var spacing: CGFloat = 5
    /// PURE WHITE, not Theme.text.
    ///
    /// Theme.text is white at 0.95 and the fill below multiplies it again, so a
    /// shout peaked at 0.95 and an ordinary speaking level landed near 0.64 —
    /// which is why the waveform never looked white. The capsule is pitch black
    /// and the waveform is the only thing in it; it should be the brightest
    /// thing on the surface.
    var color: Color = .white

    @State private var envelope: Double = 0

    /// How far from the centre line a dot may go without clipping its own
    /// capsule out of the frame.
    private var travel: CGFloat { max(0, height / 2 - dotSize / 2) }

    var body: some View {
        // ONE CLOCK FOR THE WHOLE ROW, and none at all while it is silent.
        //
        // `paused` is not an optimisation detail — it is the contract. With the
        // envelope at zero there is nothing to redraw, so a muted mic costs no
        // frames and, more to the point, CANNOT move: the still row is the
        // state the view rests in rather than a shape it happens to be drawing.
        TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: envelope <= 0)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            HStack(alignment: .center, spacing: spacing) {
                ForEach(0..<dots, id: \.self) { i in
                    let y = DotWave.offset(index: i, count: dots, time: t, amplitude: envelope)
                    Circle()
                        // Brighter across the whole range, peaking at pure
                        // white — and the row lifts as a whole rather than
                        // per-dot, so brightness reads as LEVEL and the
                        // vertical spread reads as shape. Silence keeps enough
                        // opacity to stay a visible row: dots you cannot see
                        // are indistinguishable from a surface that has stopped
                        // drawing, which is the one reading this must not have.
                        .fill(color.opacity(0.4 + 0.6 * envelope))
                        .frame(width: dotSize, height: dotSize)
                        .offset(y: CGFloat(y) * travel)
                }
            }
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
    /// a bar's height now sets the whole row's amplitude, so the surface reacts
    /// to a voice exactly as it did before.
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
            // Fewer dots than the pill and a shorter travel: the chip is an
            // inline mark in a crowded row, so it carries the bottom of the
            // five-to-ten range rather than the middle.
            Waveform(level: level,
                     dots: compact ? 5 : 6,
                     height: compact ? 9 : 11,
                     dotSize: compact ? 2.5 : 3, spacing: compact ? 3 : 3.5,
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
