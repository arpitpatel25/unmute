import XCTest
@testable import LevelMeterSupport

final class LevelMeterTests: XCTestCase {

    // THE BUG THIS EXISTS FOR. Auto-gain normalised each frame against a
    // decaying peak. In a quiet room the peak decayed to its floor, room tone
    // divided by room tone came out at 1.0, and the pill drew a full-height
    // wave with nobody speaking — random, because the input was noise.
    func testAnEmptyRoomDrawsNothing() {
        XCTAssertEqual(LevelMeter.target(for: 0.008), 0, "room tone is not a signal")
        XCTAssertEqual(LevelMeter.target(for: 0), 0)
        XCTAssertEqual(LevelMeter.target(for: LevelMeter.gate), 0, "the gate itself is closed")
    }

    // A DEAD MIC STAYS DEAD however long it is watched. The envelope must never
    // walk upward on its own — that is the one lie this view cannot tell.
    func testSilenceNeverDriftsUpward() {
        var e = 0.0
        for _ in 0..<500 { e = LevelMeter.advance(e, toward: LevelMeter.target(for: 0.006)) }
        XCTAssertEqual(e, 0)
    }

    // Ordinary speech (rms 0.02-0.04 ⇒ level 0.08-0.16) has to be plainly
    // visible. The complaint before the gain was added was a flat-looking pill;
    // the fix must not swing back to that.
    func testOrdinarySpeechIsClearlyVisible() {
        let quiet = LevelMeter.target(for: 0.08)
        let loud  = LevelMeter.target(for: 0.16)
        XCTAssertGreaterThan(quiet, 0.20, "a soft sentence still reads")
        XCTAssertLessThan(loud, 1.0, "and an ordinary one leaves headroom")
        XCTAssertGreaterThan(loud, quiet, "louder is taller")
    }

    // MONOTONIC, so the shape tracks the voice rather than decorating it.
    func testLouderIsAlwaysTaller() {
        var last = -1.0
        for i in stride(from: 0.0, through: 1.0, by: 0.01) {
            let v = LevelMeter.target(for: i)
            XCTAssertGreaterThanOrEqual(v, last)
            last = v
        }
    }

    // DETERMINISTIC. The same voice at the same volume draws the same height
    // in a quiet room and a loud one. This is the property adaptive gain traded
    // away, and the reason the old meter felt fabricated.
    func testTheSameLevelAlwaysDrawsTheSameHeight() {
        XCTAssertEqual(LevelMeter.target(for: 0.12), LevelMeter.target(for: 0.12))
        // (0.12 - 0.03) / (0.40 - 0.03) = 0.243, and 0.243^0.75 = 0.346.
        XCTAssertEqual(LevelMeter.target(for: 0.12), 0.3464, accuracy: 0.005)
    }

    func testTheCeilingFillsTheBarAndClamps() {
        XCTAssertEqual(LevelMeter.target(for: LevelMeter.ceiling), 1.0, accuracy: 0.0001)
        XCTAssertEqual(LevelMeter.target(for: 1.0), 1.0, accuracy: 0.0001)
    }

    // RISE FAST, FALL SLOW — the asymmetry is the point. A symmetric filter
    // either lags the onset of a word or chatters on its tail.
    func testItRisesFasterThanItFalls() {
        let up = LevelMeter.advance(0, toward: 1)
        let down = 1 - LevelMeter.advance(1, toward: 0)
        XCTAssertGreaterThan(up, down, "attack outruns release")
    }

    // Smoothing has to actually smooth: alternating frames must not reach the
    // extremes they would if each were drawn raw.
    func testAlternatingFramesDoNotChatter() {
        var e = 0.0
        var seen: [Double] = []
        for i in 0..<20 {
            e = LevelMeter.advance(e, toward: LevelMeter.target(for: i.isMultiple(of: 2) ? 0.40 : 0.05))
            seen.append(e)
        }
        let tail = seen.suffix(8)
        XCTAssertGreaterThan(tail.min()!, 0.15, "never slams to the floor between frames")
        XCTAssertLessThan(tail.max()!, 0.95, "nor to the ceiling")
    }

    func testAnEnvelopeConvergesOnASteadyTone() {
        var e = 0.0
        let t = LevelMeter.target(for: 0.2)
        for _ in 0..<60 { e = LevelMeter.advance(e, toward: t) }
        XCTAssertEqual(e, t, accuracy: 0.001)
    }
}
