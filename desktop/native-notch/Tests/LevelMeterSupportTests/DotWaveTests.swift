import XCTest
@testable import LevelMeterSupport

final class DotWaveTests: XCTestCase {

    private let count = 7

    // THE CONTRACT THE REDESIGN INHERITED. Flat means silent. A vibration that
    // ran on its own clock would look like proof the mic is live while it is
    // muted — the same lie the auto-gain bug told with a different shape.
    func testSilenceIsAStraightRow() {
        for t in stride(from: 0.0, through: 3.0, by: 0.017) {
            for i in 0..<count {
                XCTAssertEqual(DotWave.offset(index: i, count: count, time: t, amplitude: 0), 0)
            }
        }
    }

    // NOTHING MOVES SIDEWAYS, and the arithmetic is where that is guaranteed:
    // a dot's index only ever picks its share of the travel, never a position.
    // The check that stands in for it — the row is a STANDING wave, so the
    // pattern's sign structure is fixed in place and only its size breathes.
    func testThePatternStandsStillRatherThanTravelling() {
        // Mode A alone (sampled where mode B contributes nothing to sign) has
        // the same sign at each end of the row for all time, up to the shared
        // clock flipping the whole row at once.
        let left = DotWave.shape(DotWave.modeA, index: 0, count: count)
        let right = DotWave.shape(DotWave.modeA, index: count - 1, count: count)
        XCTAssertEqual(left, -right, accuracy: 0.0001, "second mode: ends oppose, and keep opposing")
        XCTAssertGreaterThan(abs(left), 0.5, "no dot parks on a clamp")
    }

    // A LOUD MOMENT USES THE WHOLE TRAVEL AND NEVER OVERRUNS IT. The dots have
    // to stay inside the capsule at any amplitude the meter can hand over.
    func testTravelStaysInsideTheFrame() {
        var peak = 0.0
        for t in stride(from: 0.0, through: 4.0, by: 0.003) {
            for i in 0..<count {
                let y = DotWave.offset(index: i, count: count, time: t, amplitude: 1)
                XCTAssertLessThanOrEqual(abs(y), 1.0)
                peak = max(peak, abs(y))
            }
        }
        XCTAssertGreaterThan(peak, 0.9, "and a shout is not left drawing half a wave")
    }

    // LOUDER IS BIGGER, dot for dot and frame for frame — the amplitude is a
    // plain scale on the shape, not a curve applied twice.
    func testAmplitudeScalesTheShapeLinearly() {
        let t = 0.37
        for i in 0..<count {
            let half = DotWave.offset(index: i, count: count, time: t, amplitude: 0.5)
            let full = DotWave.offset(index: i, count: count, time: t, amplitude: 1.0)
            XCTAssertEqual(half, full / 2, accuracy: 0.0001)
        }
    }

    // EVERY DOT IS ALIVE. One mode alone leaves a node in the middle of an odd
    // row: that dot would sit dead still through an entire dictation, which
    // reads as a rendering fault rather than as a still point.
    func testNoDotSitsPermanentlyStill() {
        for i in 0..<count {
            var moved = 0.0
            for t in stride(from: 0.0, through: 1.5, by: 0.01) {
                moved = max(moved, abs(DotWave.offset(index: i, count: count, time: t, amplitude: 1)))
            }
            XCTAssertGreaterThan(moved, 0.2, "dot \(i) never moves")
        }
    }

    // Holds for every row size the surfaces ask for — 5 on the compact chip
    // through 10 at the widest.
    func testEveryRowSizeIsAlive() {
        for n in 5...10 {
            for i in 0..<n {
                var moved = 0.0
                for t in stride(from: 0.0, through: 1.5, by: 0.01) {
                    moved = max(moved, abs(DotWave.offset(index: i, count: n, time: t, amplitude: 1)))
                }
                XCTAssertGreaterThan(moved, 0.15, "row of \(n): dot \(i) never moves")
            }
        }
    }

    // DETERMINISTIC, like the meter feeding it: the same instant at the same
    // level draws the same row, so nothing about this is a random generator
    // wearing a waveform's shape.
    func testTheSameInstantAlwaysDrawsTheSameRow() {
        for i in 0..<count {
            XCTAssertEqual(DotWave.offset(index: i, count: count, time: 1.25, amplitude: 0.6),
                           DotWave.offset(index: i, count: count, time: 1.25, amplitude: 0.6))
        }
    }

    // The two clocks must not relock into a short loop — that is what makes the
    // row read as a voice rather than as a looping animation.
    func testTheTwoModesDoNotShareAShortCycle() {
        let ratio = DotWave.freqB / DotWave.freqA
        XCTAssertNotEqual(ratio, ratio.rounded(), accuracy: 0.05, "an integer ratio repeats immediately")
    }
}
