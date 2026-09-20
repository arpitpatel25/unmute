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
public func composerState(alive: Bool, canCompose: Bool? = nil, canResume: Bool = true,
                          status: String, kind: String) -> ComposerState {
    if canCompose ?? alive { return .composable }
    let terminal = status == "done" || status == "failed"
    // Opening is the resume gesture. While that silent reconnect is happening,
    // reserve the composer's place instead of drawing a redundant Resume button.
    if canResume || kind == "session" || !terminal { return .notRunning }
    return .finished
}

// WHETHER TO OFFER STOP — whenever work is VISIBLY happening on a task that is
// ours to stop.
//
// The old gate was `isOwned && alive && (processing || needsUser)`. Both
// `alive` and `status` lag the runtime (a reattach that lost the turn-start, a
// disconnect that latched failed), so users watched a card stream output with
// no way to stop it. The engine now sends `canStop` from the runtime's own busy
// flag; the blocks' running turn — the very signal the chat's working
// indicator draws from — is the backstop, except over a settled `done` (a
// dangling turn-start left by a crash is not live work).

/// - Parameters:
///   - canStop: the engine's answer (absent from an older engine).
///   - lastTurnRunning: `BlockPresentation.lastTurnRunning(blocks)`.
public func stopAvailable(isOwned: Bool, taskId: String, canStop: Bool?,
                          status: String, lastTurnRunning: Bool) -> Bool {
    // THE AGENT'S CHAT IS NOT OWNED AND IS STILL STOPPABLE.
    //
    // It was excluded outright, on the grounds that it "has its own interrupt".
    // It did not: `remote:agent-cancel` was wired end to end and had no caller
    // anywhere in the app, so the one chat people use most was the only one a
    // long answer could not be stopped in.
    //
    // It gets its own line rather than a relaxed `isOwned`, because there is no
    // process of ours behind it and never will be — and the task signals below
    // are signals it does not carry: no executor, so no `alive`, and no
    // turn-start blocks to run. Its busy flag is `processing`, and the engine
    // now says so outright in `canStop`.
    if taskId == "unmute-agent" { return canStop ?? (status == "processing") }
    guard isOwned else { return false }
    if canStop == true { return true }
    if status == "processing" || status == "needs-user" { return true }
    return lastTurnRunning && status != "done" && status != "failed"
}
