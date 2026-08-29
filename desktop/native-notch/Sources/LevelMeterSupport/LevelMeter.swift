import Foundation

/// THE MIC SIGNAL, TURNED INTO A HEIGHT.
///
/// Split out of `Waveform` so it can be tested: the executable target imports
/// SwiftUI and cannot be imported by a test target. This is the arithmetic
/// only — the drawing stays in the view.
///
/// It exists as its own unit because the numbers here are the whole behaviour,
/// and getting them wrong is INVISIBLE IN A DIFF. A previous revision
/// normalised each frame against a decaying peak, which looks reasonable
/// written down and, in the field, amplified an empty room to full height:
/// the peak decayed to its floor, and dividing room tone by room tone is 1.0.
/// Noise scaled to full scale is a random number generator with a waveform's
/// shape. Everything below is arranged so that cannot happen again.
public enum LevelMeter {

    // THE SIGNAL, AS IT ACTUALLY ARRIVES. The engine sends `min(1, rms * 4)`
    // every 70ms. Measured speech RMS is 0.02-0.04, so an ordinary sentence
    // lands around 0.08-0.16 — the useful range is the BOTTOM of 0...1, and
    // these are calibrated against that rather than against a theoretical full
    // scale that nothing short of clipping ever reaches.

    /// Below this, draw nothing. Room tone and a muted mic both live here.
    ///
    /// This view's one job is answering "is it hearing me", so the failure that
    /// matters is drawing a wave when nothing was said. A fixed gate in the
    /// signal's own units is the only honest way to hold that line — an
    /// adaptive one re-floors itself around whatever noise it is given.
    /// Lowered from 0.03. The old gate sat above ordinary quiet speech — a
    /// normal voice at a normal distance from a laptop mic — so the surface
    /// stayed flat while somebody was actually talking. It still has to close
    /// on room tone, which is why this is a small move and not a removal.
    public static let gate: Double = 0.018

    /// The level that fills the bar. A loud moment, not a shout.
    /// Lowered from 0.40. With the ceiling that high an ordinary speaking
    /// voice lived in the bottom third of the bar and the top two thirds were
    /// reserved for shouting. Bringing it down spends the height on the range
    /// a voice actually occupies.
    public static let ceiling: Double = 0.32

    /// Rise fast, fall slow — how a voice decays, and how every hardware meter
    /// has behaved for fifty years.
    ///
    /// Frames arrive 70ms apart, far too slow for consecutive samples of speech
    /// to resemble each other. Drawn raw they are 20 independent numbers, and
    /// independent numbers look like noise BECAUSE THEY ARE. The envelope is
    /// what makes neighbouring bars parts of one shape.
    ///
    /// Attack eased from 0.55: at that rate a single loud frame snapped the bar
    /// to full height in one step, which reads as a flicker rather than a rise.
    /// 0.42 still gets there in about three frames — fast enough to track a
    /// voice, slow enough that consecutive bars belong to one shape.
    public static let attack: Double = 0.42
    public static let release: Double = 0.22

    /// Where a raw level sits in the bar, before smoothing. 0…1.
    ///
    /// Gated, then curved. The exponent spends the height on the range a voice
    /// occupies without inventing signal where there is none: the same sentence
    /// at the same volume draws the same shape every time, which is exactly
    /// what an adaptive gain cannot promise.
    public static func target(for raw: Double) -> Double {
        let v = min(1, max(0, raw))
        guard v > gate else { return 0 }
        let norm = min(1, (v - gate) / (ceiling - gate))
        // 0.62 rather than 0.75: a lower exponent lifts the quiet end of the
        // range, which is where speech mostly lives, without touching the loud
        // end. This is what makes a soft sentence draw a shape instead of a
        // twitch above the line.
        return pow(norm, 0.62)
    }

    /// One frame of envelope movement toward `target`.
    public static func advance(_ envelope: Double, toward target: Double) -> Double {
        let rate = target > envelope ? attack : release
        let next = envelope + (target - envelope) * rate
        // Park exactly on zero rather than approaching it forever, so a long
        // silence is a clean flat line and not a row of ghost pixels.
        return next < 0.004 ? 0 : next
    }
}
