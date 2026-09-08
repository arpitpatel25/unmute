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

// MARK: - barHeight
//
// The bar row replaced the dot row because the dots all travelled the same
// distance: the shape never changed, only its altitude. These guard the two
// properties that make the new row worth having, plus the one contract it
// inherited unchanged.

final class BarHeightTests: XCTestCase {

    private let count = 11

    // THE INHERITED CONTRACT, and the reason this surface is honest. Flat means
    // silent — for every bar, at every instant, forever. The view draws a bar
    // at its floor height when this returns 0, so a muted mic is a still row
    // and cannot be mistaken for decoration that would wobble regardless.
    func testSilenceIsExactlyZeroForEveryBar() {
        for t in stride(from: 0.0, through: 3.0, by: 0.017) {
            for i in 0..<count {
                XCTAssertEqual(
                    DotWave.barHeight(index: i, count: count, time: t, amplitude: 0), 0)
            }
        }
    }

    // THE WHOLE POINT OF THE REDESIGN. At a single instant the bars must NOT
    // all be the same height — that was the old row's failure ("the length
    // doesn't increase, it just waves"). The arch alone guarantees it even if
    // the oscillation happened to be flat.
    func testBarsDifferFromEachOtherAtTheSameInstant() {
        for t in stride(from: 0.0, through: 2.0, by: 0.05) {
            let hs = (0..<count).map {
                DotWave.barHeight(index: $0, count: count, time: t, amplitude: 1)
            }
            let spread = (hs.max() ?? 0) - (hs.min() ?? 0)
            XCTAssertGreaterThan(spread, 0.1,
                                 "the row is a flat block at t=\(t) — no shape to read")
        }
    }

    // A BAR NEVER LEAVES ITS BAND. The view maps 0…1 onto floor…height, so
    // anything outside that range would draw a bar clipped out of the capsule.
    func testHeightStaysWithinTheBand() {
        for t in stride(from: 0.0, through: 3.0, by: 0.017) {
            for a in [0.01, 0.25, 0.5, 0.9, 1.0] {
                for i in 0..<count {
                    let h = DotWave.barHeight(index: i, count: count, time: t, amplitude: a)
                    XCTAssertGreaterThanOrEqual(h, 0)
                    XCTAssertLessThanOrEqual(h, 1)
                }
            }
        }
    }

    // LOUDER IS TALLER, which is the one thing a level meter must get right.
    // Compared per-bar at a fixed instant so the oscillation cancels out.
    func testLouderIsNeverShorter() {
        for t in stride(from: 0.0, through: 2.0, by: 0.05) {
            for i in 0..<count {
                let quiet = DotWave.barHeight(index: i, count: count, time: t, amplitude: 0.3)
                let loud  = DotWave.barHeight(index: i, count: count, time: t, amplitude: 0.9)
                XCTAssertGreaterThanOrEqual(loud, quiet)
            }
        }
    }

    // NO BAR COLLAPSES WHILE A VOICE IS GOING. A bar that reaches zero
    // mid-phrase reads as a dropped frame, not as a quiet band — that is what
    // the two floors are for, and this is the check that they are wired up.
    func testNoBarVanishesWhileSpeaking() {
        for t in stride(from: 0.0, through: 3.0, by: 0.017) {
            for i in 0..<count {
                XCTAssertGreaterThan(
                    DotWave.barHeight(index: i, count: count, time: t, amplitude: 1), 0.05,
                    "bar \(i) collapsed at t=\(t)")
            }
        }
    }

    // THE COUNT IS A SLOT COUNT, not a budget that grows with volume: the same
    // index in the same row is a pure function of time and level, so nothing
    // can make the row wider mid-dictation.
    func testDeterministic() {
        for i in 0..<count {
            XCTAssertEqual(DotWave.barHeight(index: i, count: count, time: 1.25, amplitude: 0.6),
                           DotWave.barHeight(index: i, count: count, time: 1.25, amplitude: 0.6))
        }
    }
}
