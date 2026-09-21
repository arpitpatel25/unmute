import Foundation

// WHICH TWO FACTS THE CLOSED SURFACE GETS TO SAY.
//
// The bar has two shoulders and the vocabulary has six words, so the whole
// question is which two things are named. The answer is not "the two most
// recent" or "whatever the rung happens to be" — it is one fact per shoulder,
// and they are different KINDS of fact:
//
//   * RIGHT is what is running. Always. It is the one thing the surface can
//     state without the user having to act on it.
//   * LEFT is the most urgent thing that WANTS you. Everything below the top
//     rung folds into the pocket rather than competing for the shoulder.
//
// The bar used to be able to say only one of those. The waiting branch in
// BarContent returned above the state switch, so a pocket holding a single
// question hid three running tasks completely — the surface told you about the
// thing you could not do anything about and stayed silent about the rest.
//
// See docs/superpowers/specs/steps/hover-cases.html.
enum BarShoulders {

    /// One shoulder's worth of content: a status, and how many are in it.
    ///
    /// The word and the colour both come from the status (Theme owns both), so
    /// there is no third place for the vocabulary to drift into.
    struct Rung: Equatable {
        let status: TaskStatus
        let count: Int
    }

    /// THE LADDER, most urgent first.
    ///
    /// `stuck` and `failed` share red because they are the same news to the
    /// person — something has gone wrong and only you can move it — but they
    /// are ranked rather than merged: a failure is final and a block is not, so
    /// a bar holding both names the failure.
    ///
    /// `ready` sits at the bottom because it is good news. It still wants you
    /// (a finished task nobody has looked at is not finished, from the user's
    /// side) but it never outranks a question.
    private static let ladder: [TaskStatus] = [.failed, .stuck, .needsUser, .ready]

    /// What the LEFT shoulder says, or nil when nothing wants you — in which
    /// case the left falls back to the mark.
    ///
    /// Reads the pocket slots rather than a count off the wire, because the
    /// slots are the only place the per-status breakdown exists. They are also
    /// the same array `pocket.waiting` is derived from, so the shoulder and the
    /// badge cannot disagree — which is exactly the failure `waiting` was
    /// introduced to end.
    static func wanting(_ slots: [PocketSlotP]) -> Rung? {
        // THE SAME TWO EXCLUSIONS THE BADGE MAKES, and for the same reasons:
        // the Agent is permanently in the pocket, so counting it would put a
        // standing +1 on a number meaning "things waiting on you"; and a slot
        // that is not demanding is work you have already dealt with.
        let waiting = slots.filter { ($0.demanding ?? false) && $0.kind != "agent" }
                           .compactMap { status(of: $0) }
        for rung in ladder {
            // THE NUMBER COUNTS WHAT THE WORD NAMES. Totalling every waiting
            // task under the top rung's word would write "Errored 3" on a bar
            // holding one failure and two questions — three different pieces of
            // news wearing the most alarming of the three labels.
            let n = waiting.filter { $0 == rung }.count
            if n > 0 { return Rung(status: rung, count: n) }
        }
        return nil
    }

    /// What the RIGHT shoulder says, or nil when nothing is running.
    static func running(_ working: Int) -> Rung? {
        working > 0 ? Rung(status: .processing, count: working) : nil
    }

    /// A SLOT'S STATUS, AS THE BAR MEANS IT.
    ///
    /// The wire has no `ready`: the engine's states are processing / needs-user
    /// / done / failed / stuck (status-file.ts). "Ready" is what a `done` task
    /// becomes when it is still demanding — finished, and nobody has looked at
    /// it yet. Once the demand window closes it stops being in this list at
    /// all, which is the only difference between Ready and Done that the closed
    /// surface can act on.
    private static func status(of slot: PocketSlotP) -> TaskStatus? {
        guard let raw = slot.status, let s = TaskStatus(rawValue: raw) else { return nil }
        return s == .done ? .ready : s
    }
}
