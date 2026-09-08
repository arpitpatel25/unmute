import Foundation

/// A ROW OF DOTS THAT VIBRATES IN PLACE.
///
/// The scrolling bar history this replaces answered "is it hearing me" by
/// SHIFTING LEFT — a second of speech drifting off the edge. On a 78pt strip
/// pinned under the notch that horizontal travel is the loudest thing in the
/// frame: the eye tracks the motion rather than reading the shape, and next to
/// a cursor that is also moving it reads as a second thing scrolling.
///
/// So the dots stay exactly where they are and only move UP AND DOWN. What
/// carries the signal is the same envelope as before; what carries the *shape*
/// is a STANDING WAVE — every dot shares one clock, and its position in the row
/// fixes how much of that clock it gets. That is what makes seven dots read as
/// one vibrating string rather than seven independent bouncers, and it is why
/// nothing here is a function of "how far along the row the crest has got":
/// there is no crest travelling anywhere.
///
/// Split out of the view for the same reason `LevelMeter` was — the numbers ARE
/// the behaviour, and a wave that quietly drifts sideways or that hums at rest
/// is invisible in a diff.
public enum DotWave {

    /// TWO MODES, NOT ONE. A single mode has fixed nodes: with the second
    /// harmonic alone the middle dot sits at a node and never moves for the
    /// whole dictation, which looks like a dead pixel rather than a still
    /// point. A second, faster mode on a different shape keeps every dot alive
    /// while staying a standing pattern.
    static let modeA: Double = 2
    static let modeB: Double = 3

    /// Hz. Deliberately INCOMMENSURATE (3.1 against 5.3): a rational ratio
    /// repeats on a short cycle and the row starts to look like a looping
    /// animation, which is the thing the old timer was replaced for.
    static let freqA: Double = 3.1
    static let freqB: Double = 5.3

    /// How much of the travel the second mode is allowed. Enough to unstick the
    /// nodes, not enough to break the string into independent dots.
    static let mixB: Double = 0.5

    /// The dot's share of a given mode: a string clamped at both ends, sampled
    /// at this dot's position. The dots are inset by one slot at each end
    /// (`(i+1)/(n+1)`) so no dot sits exactly on the clamp and stays still.
    static func shape(_ mode: Double, index: Int, count: Int) -> Double {
        guard count > 0 else { return 0 }
        return sin(Double.pi * mode * Double(index + 1) / Double(count + 1))
    }

    /// Where dot `index` sits, as -1…1 of the available travel.
    ///
    /// `amplitude` is the smoothed envelope from `LevelMeter`, so SILENCE IS A
    /// STRAIGHT ROW — exactly zero for every dot, however long it is watched.
    /// That contract is the whole point of the surface and it survives the
    /// redesign unchanged: a decorative wobble that ran regardless would look
    /// like proof of something it is not checking.
    public static func offset(index: Int, count: Int, time: Double, amplitude: Double) -> Double {
        guard amplitude > 0 else { return 0 }
        let a = shape(modeA, index: index, count: count) * sin(2 * .pi * freqA * time)
        let b = shape(modeB, index: index, count: count) * sin(2 * .pi * freqB * time)
        // Normalised by the worst case both modes can sum to, so a loud moment
        // uses the full travel and never exceeds it.
        let mixed = (a + mixB * b) / (1 + mixB)
        return max(-1, min(1, amplitude * mixed))
    }
}
