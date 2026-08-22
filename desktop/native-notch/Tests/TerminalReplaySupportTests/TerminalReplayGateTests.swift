import XCTest
@testable import TerminalReplaySupport

final class TerminalReplayGateTests: XCTestCase {

    // THE BUG THIS EXISTS FOR. A real terminal emulator (SwiftTerm, xterm.js —
    // any of them) auto-answers standard capability queries (device
    // attributes, cursor/window-size reports) baked into whatever bytes it is
    // fed. We replay the ENTIRE historical PTY buffer into a fresh emulator
    // instance on every reattach, so a query the process asked once, long ago,
    // gets re-answered every single time — and that reply, if forwarded, goes
    // right back into the live PTY as if a human had typed it. Nothing may be
    // forwarded until the replay boundary is explicitly marked done.
    func testForwardingIsBlockedUntilReplayIsMarkedDone() {
        var pending: [() -> Void] = []
        let gate = TerminalReplayGate(schedule: { pending.append($0) })

        XCTAssertFalse(gate.shouldForward(), "must not forward before replay ever completes")

        gate.markReplayDone()
        XCTAssertFalse(
            gate.shouldForward(),
            "the flip to live must be deferred, not synchronous — a delegate call " +
            "landing a tick after the parse that triggered it must still be caught"
        )

        pending.forEach { $0() }
        XCTAssertTrue(gate.shouldForward(), "once the deferred flip actually runs, forwarding is allowed")
    }

    func testDisposeStopsForwardingEvenAfterGoingLive() {
        var pending: [() -> Void] = []
        let gate = TerminalReplayGate(schedule: { pending.append($0) })
        gate.markReplayDone()
        pending.forEach { $0() }
        XCTAssertTrue(gate.shouldForward())

        gate.dispose()
        XCTAssertFalse(gate.shouldForward())
    }

    // A SECOND (or third, ...) buffered chunk fed to the terminal after the
    // first must not re-arm the gate — only the first chunk after a fresh
    // attach marks the replay boundary.
    func testMarkReplayDoneIsIdempotent() {
        var scheduleCount = 0
        let gate = TerminalReplayGate(schedule: { _ in scheduleCount += 1 })
        gate.markReplayDone()
        gate.markReplayDone()
        gate.markReplayDone()
        XCTAssertEqual(scheduleCount, 1, "a second/third replay chunk arriving must not re-schedule the flip")
    }

    func testMarkReplayDoneAfterDisposeIsANoOp() {
        var scheduleCount = 0
        let gate = TerminalReplayGate(schedule: { _ in scheduleCount += 1 })
        gate.dispose()
        gate.markReplayDone()
        XCTAssertEqual(scheduleCount, 0)
        XCTAssertFalse(gate.shouldForward())
    }
}
