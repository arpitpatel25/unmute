import Foundation

/// Delays forwarding whatever a terminal emulator hands back to us, until any
/// auto-generated replies produced while it was fed OLD, already-buffered PTY
/// history have had their one chance to happen.
///
/// A real terminal emulator (SwiftTerm here; xterm.js on the Electron side)
/// auto-answers standard capability queries a TUI process sends on startup —
/// device attributes, cursor/window-size reports. That is correct in a normal
/// 1:1 terminal↔process relationship: the reply has to go back to the one
/// process that asked. We are not 1:1 — every hide→show reattach replays the
/// ENTIRE historical PTY buffer into a fresh emulator instance, so a query the
/// process asked exactly once, long ago, gets re-answered on every reattach.
/// Forwarding that stale reply into the live PTY is what piles up as garbage
/// escape-sequence text on screen. Mirrors `terminal-replay-gate.ts` on the
/// Electron/xterm.js side of the same bug.
public final class TerminalReplayGate {
    private var live = false
    private var disposed = false
    private var scheduled = false
    private let schedule: (@escaping () -> Void) -> Void

    /// `schedule` defers the actual flip to live by one tick beyond the
    /// caller's own "replay is done" signal — a safety margin for a delegate
    /// callback that lands a moment after the parse call that triggered it.
    /// Production wiring passes `DispatchQueue.main.async`; tests pass a
    /// queue they step by hand.
    public init(schedule: @escaping (@escaping () -> Void) -> Void) {
        self.schedule = schedule
    }

    /// Call once the replay boundary is known: the first chunk fed to the
    /// terminal after a fresh attach has finished being parsed (or, if there
    /// is no buffered history at all, immediately — a task must still be able
    /// to go live with nothing to replay).
    public func markReplayDone() {
        guard !disposed, !scheduled else { return }
        scheduled = true
        schedule { [weak self] in
            guard let self, !self.disposed else { return }
            self.live = true
        }
    }

    /// Whether data the terminal emits right now may be forwarded to the real
    /// backend PTY as input.
    public func shouldForward() -> Bool { live && !disposed }

    public func dispose() {
        disposed = true
        live = false
    }
}
