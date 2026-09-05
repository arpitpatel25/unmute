// WHETHER TO OFFER A TEXT BOX — ASKED AS A CAPABILITY QUESTION, NOT A
// LIFECYCLE ONE.
//
// The old gate was:
//
//     ended(t) = (status == .done || status == .failed) && kind != "session"
//     if !ended(t) { CodexComposer(...) }
//
// which asks "is this task conceptually finished?". What actually decides
// whether a text box is worth showing is "can I send to it right now?" — and
// the delivery layer already computes exactly that, from the same executor:
//
//     ex?.alive && ex.writeDraftText && ex.submitDraft
//
// The UI never consulted it, so the two layers disagreed, in both directions:
//
//   * BOX HIDDEN WHILE SENDING WORKED. A one-off that reaches `done` is parked
//     WARM for 8-15 minutes with its executor alive and its terminal live. The
//     old gate hid the composer the instant the status flipped. Observed in the
//     field as replies landing on done one-off tasks through the Remote key —
//     which bypasses the box — while the box itself was gone.
//   * BOX SHOWN WHILE SENDING WAS REFUSED. After the app restarts, a task's
//     executor is gone but the row survives. The composer sat there over a dead
//     session and every send was retained and silently refused: the user typed
//     into nothing, with `deliveryError` already set and shipped but no place
//     shown to put it.
//
// `alive` is the honest input and it is already in the detail payload, derived
// from `TaskManager.isAlive` → `this.executors.get(id)?.alive`. Driver-backed
// threads (Codex desktop) have no PTY, and the engine reports `alive: true` for
// them deliberately, so this needs no special case for them.

/// What the surface should offer where the composer goes.
public enum ComposerState: Equatable {
    /// Live executor — type and send.
    case composable
    /// No executor, but there is something to resume into. Say so, and offer it,
    /// rather than presenting a box that silently swallows what is typed.
    case notRunning
    /// A one-off errand that ended and has no executor: nothing to say, nothing
    /// to resume. The only case the old `ended()` rule got right.
    case finished
}

/// Decide from what the detail payload already carries.
public func composerState(alive: Bool, canCompose: Bool? = nil, status: String, kind: String) -> ComposerState {
    if canCompose ?? alive { return .composable }
    let terminal = status == "done" || status == "failed"
    // A session is never "over" — it is waiting for your next line, and a dead
    // executor is a thing to restart rather than a thing to hide.
    if kind == "session" || !terminal { return .notRunning }
    return .finished
}
