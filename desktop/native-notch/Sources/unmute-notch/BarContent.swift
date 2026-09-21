import AppKit
import SwiftUI

// WHAT THE BAR-LEVEL MASS SAYS, AND HOW WIDE EACH HALF MUST BE TO SAY IT.
//
// ONE source for both. AppController sizes the window from these widths and
// NotchView renders exactly these strings in exactly these fonts, so the frame
// and the message cannot drift apart — when they were computed separately the
// message was either clipped or the surface carried dead space beside it.
//
// The split follows the hardware. On a notched display the left half sits left
// of the housing and the right half sits right of it, with the mass drawn
// straight through the middle; on a display without one the same two halves sit
// either side of a plain gap. Neither half knows which it is.
//
// WHAT GOES WHERE, and it is not interchangeable:
//   * LEFT is status. Short by construction, never truncated, and the thing
//     that has to stay readable when there is no room. A status indicator that
//     can be cut off is not a status indicator.
//   * RIGHT is detail — the current activity, the question being asked. It
//     truncates first and is dropped entirely when it cannot say anything
//     useful (NotchGeometry.mass).
/// Bar-level only: the expanded surfaces draw their own chrome.
private func isExpandedState(_ s: NotchState) -> Bool { s == .task || s == .cockpit }

struct BarContent: Equatable {
    /// How the left half is set: an identity, or a state.
    enum Emphasis { case wordmark, status }

    /// Status dot, left of the words. nil = no dot.
    var dot: TaskStatus? = nil
    var left: String? = nil
    var emphasis: Emphasis = .status
    /// THE RIGHT SHOULDER IS A STATUS TOO, NOT A SENTENCE.
    ///
    /// It used to carry free text — a task title, an activity line, the text of
    /// the question being asked. That is what made the mass unsizeable: the
    /// content was unbounded, so the width was either computed per-frame (and
    /// visibly jumped) or fixed at the worst case the vocabulary could produce
    /// (and the idle bar paid for words it was not showing). With titles gone
    /// both shoulders draw from the same six-word vocabulary.
    var rightDot: TaskStatus? = nil
    var right: String? = nil
    /// THE ONE SENTENCE THE BAR STILL CARRIES, and it is not a shoulder.
    ///
    /// A toast is feedback for something the user just did at this surface, so
    /// the reason must stay where the action was — and the six-word vocabulary
    /// has no word for "why". It keeps the policy the right half used to have
    /// for everything: it truncates, and it is dropped whole when it cannot say
    /// anything useful (NotchGeometry.mass).
    ///
    /// Kept apart from `right` because shoulders are SYMMETRIC. Mirroring an
    /// error sentence into the left half would double it; the field build that
    /// prompted this separation logged `mass=[401|185|401]` — a 1007pt bar.
    var detail: String? = nil
    /// HOW MANY, and it is drawn even at 1. It used to mean "and N MORE like
    /// this", so it was hidden below 2; it now means "this many", which is a
    /// fact about one task as much as about five. A shoulder that names a
    /// status without saying how many leaves the user to guess.
    var badge: Int? = nil
    var rightBadge: Int? = nil
    /// Attention is the ONE state that glows, and this is what says so.
    var alarm: TaskStatus? = nil
    /// RESTING: idle, off-notch, pointer elsewhere. Nothing to say, so nothing
    /// is said — the surface shrinks to a small nub instead of a full-height
    /// bar wearing a wordmark. See NotchView.restingNub.
    var resting: Bool = false

    // ── Metrics. The view reads these too; nothing here is duplicated there. ──

    static let dotSize: CGFloat = 7
    /// Outer breathing room at each far end of the mass.
    static let inset: CGFloat = 13
    /// Gap between elements inside a half, and between a half and the middle.
    static let gap: CGFloat = 6
    /// SPACE AT EACH OUTER EDGE OF THE MASS, and it is ONE number.
    ///
    /// The mark used to get a wider lead-in than everything else, on the
    /// reasoning that a wordmark looks pinned where a small round dot reads as
    /// inset already. True about the mark on its own, and wrong about the bar:
    /// it left 21pt before the mark and 13pt after the badge, so the content
    /// sat visibly lopsided inside its own silhouette. The concave flare takes
    /// the same bite out of both ends, so both ends get the same allowance.
    static let edgeInset: CGFloat = inset + 8
    /// The wordmark is tracked out; tracking is width and has to be counted.
    static let wordmarkTracking: CGFloat = 2.1

    static let wordmarkSize: CGFloat = 9.5
    /// Cap height of the drawn mark that replaced the word "unmute".
    static let markHeight: CGFloat = 13
    static let statusSize: CGFloat = 11
    static let detailSize: CGFloat = 11.5

    static let wordmarkFont = NSFont.systemFont(ofSize: wordmarkSize, weight: .light)
    static let statusFont   = NSFont.systemFont(ofSize: statusSize, weight: .medium)
    static let detailFont   = NSFont.systemFont(ofSize: detailSize, weight: .regular)

    static func measure(_ s: String, _ font: NSFont, tracking: CGFloat = 0) -> CGFloat {
        (s as NSString).size(withAttributes: [.font: font]).width + tracking * CGFloat(s.count)
    }

    /// A resting nub carries no text, so it has no natural width — and a mass
    /// measured from empty content would collapse to the fillets and take the
    /// hit target with it. This is the whole point of the state, so the width
    /// is stated rather than derived.
    static let restingWidth: CGFloat = 56

    /// Width the left half needs to be shown WHOLE. It is never cut down to fit.
    var leftWidth: CGFloat {
        if resting { return Self.restingWidth }
        guard dot != nil || (left?.isEmpty == false) else { return 0 }
        // The mark alone is the one thing that is placed rather than listed,
        // and it is the only user of the wider lead-in.
        var w = Self.edgeInset
        if dot != nil { w += Self.dotSize + Self.gap }
        if emphasis == .wordmark {
            // The identity is DRAWN now (UnMark), so its width is a geometric
            // fact rather than a text measurement.
            w += UnMark.width(for: Self.markHeight)
        } else if let t = left, !t.isEmpty {
            w += Self.measure(t, Self.statusFont)
        }
        if let b = badge { w += Self.gap + Self.badgeWidth(b) }
        return ceil(w + Self.gap)
    }

    /// Width the right half needs. Same arithmetic as the left, because it is
    /// now the same kind of thing.
    var rightWidth: CGFloat {
        guard rightDot != nil || (right?.isEmpty == false) else { return 0 }
        var w = Self.edgeInset
        if rightDot != nil { w += Self.dotSize + Self.gap }
        if let t = right, !t.isEmpty { w += Self.measure(t, Self.statusFont) }
        if let b = rightBadge { w += Self.gap + Self.badgeWidth(b) }
        return ceil(w + Self.gap)
    }

    /// SHOULD THE MARK BE CENTRED IN THE SHOULDER IT WAS GIVEN?
    ///
    /// Both shoulders are set to the wider of the two, so a bar saying
    /// "unmute | Working 3" hands the mark a shoulder sized for the status and
    /// — left-aligned, like the list of pieces a status shoulder is — pins it
    /// to the outer edge with the whole surplus as dead black between it and
    /// the housing. It reads as abandoned rather than placed.
    ///
    /// Only the MARK moves. A status shoulder is a list of pieces that starts
    /// at its inset and grows; centring that would make the dot drift with the
    /// length of the word next to it.
    func centresMark(inShoulderOf width: CGFloat) -> Bool {
        emphasis == .wordmark && dot == nil && width > leftWidth + 1
    }

    /// Width the detail sentence WANTS. What it gets is decided by the screen.
    var detailWidth: CGFloat {
        guard let t = detail, !t.isEmpty else { return 0 }
        return ceil(Self.gap + Self.measure(t, Self.detailFont) + Self.inset)
    }

    /// WHAT BOTH SHOULDERS ARE SET TO — the wider of the two, worn by each.
    ///
    /// This was briefly per-shoulder, because the mark sat stranded in a
    /// shoulder sized for three words. That was the right complaint about the
    /// wrong cause: the answer is to CENTRE the mark in the shoulder it was
    /// given (see `centresMark`), not to shrink the shoulder around it.
    /// Shrinking traded a gap for a visibly lopsided surface, which is worse —
    /// a thing that straddles a piece of hardware has to match on both sides of
    /// it, and the mass is the only part of this app the eye can compare
    /// against something physical.
    ///
    /// Sizing to the CONTENT rather than to the worst case the vocabulary could
    /// produce is what keeps it honest: with task titles off the bar the range
    /// is roughly 291-420pt against the 205-1461pt it used to span.
    var shoulders: (left: CGFloat, right: CGFloat) {
        let sh = max(leftWidth, rightWidth)
        return (leftWidth > 0 ? sh : 0, rightWidth > 0 ? sh : 0)
    }

    /// The count badge: two digits at most before it stops being a count.
    static func badgeWidth(_ n: Int) -> CGFloat {
        ceil(measure("\(n)", NSFont.systemFont(ofSize: 9.5, weight: .semibold)) + 10)
    }

    /// WHAT THIS SAYS, as one comparable value. The key the two-second rule is
    /// built on — see NotchModel.silenced. Deliberately content, not rung: the
    /// same sentence shown by two different rungs is the same announcement, and
    /// two different sentences from one rung are two announcements.
    ///
    /// `right` is included because it is the half that names the task or
    /// carries the question, so a genuinely new question in an unchanged status
    /// is new news. `resting` is not — a nub says nothing.
    var signature: String {
        "\(dot?.rawValue ?? "-")|\(left ?? "")|\(badge ?? 0)"
        + "|\(rightDot?.rawValue ?? "-")|\(right ?? "")|\(rightBadge ?? 0)"
        + "|\(detail ?? "")"
    }

    var isEmpty: Bool {
        dot == nil && rightDot == nil && (left?.isEmpty != false)
            && (right?.isEmpty != false) && (detail?.isEmpty != false)
    }

    // MARK: - What each state says

    /// The state table from the spec, in code and nowhere else.
    ///
    /// HOVER REVEALS, it never opens. Each state has one more level of detail
    /// available to a pointer that stops on it, and that is the whole of what
    /// hovering does — the panel opens on a CLICK. The menu bar is somewhere the
    /// pointer passes through constantly; a panel that opens on approach becomes
    /// something the user fights.
    ///
    /// `state` is passed in rather than read off the model: the controller
    /// resolves the content for the state it is about to move TO, and the model
    /// still holds the one it is leaving.
    static func make(for m: NotchModel, state: NotchState, hovering: Bool) -> BarContent {
        let c = resolve(for: m, state: state, hovering: hovering)
        // THE TWO-SECOND RULE, APPLIED WHERE THE WORDS ARE — the one place that
        // can actually enforce it.
        //
        // The stand-down clock in AppController changes the RUNG. That was not
        // enough on its own and never could be: every branch below the switch
        // is reached by asking only whether the state is expanded, so resting
        // from `attention` to `idle` left the pocket count matching just as
        // well as before and the bar redrew the same sentence at the same
        // width. The clock was firing into a void.
        //
        // Hovering is exempt because hover is a question being asked, and the
        // surface must answer it. Expanded surfaces are exempt because the user
        // opened them.
        guard !hovering, !isExpandedState(state), m.silenced.contains(c.signature) else { return c }
        // OFF-NOTCH KEEPS THE NUB. Silence means "stop talking", not "stop
        // existing" — on a display with no cutout there is no hardware landmark,
        // so a surface that vanished entirely would take the way into the
        // orchestrator with it. Same reasoning as `idle` below.
        return m.hasNotch ? BarContent() : BarContent(resting: true)
    }

    /// The state table from the spec, in code and nowhere else. Everything
    /// above decides whether to SAY this; this decides what it is.
    ///
    /// TWO SHOULDERS, AND THEY ARE NOT INTERCHANGEABLE. Left is the most urgent
    /// thing that wants you; right is what is running. Both are filled from the
    /// same six-word vocabulary, and neither is derived from the RUNG — the
    /// content is resolved from what is actually there, and the rung only gets
    /// to decide what happens when both shoulders come back empty. See
    /// BarShoulders, and docs/superpowers/specs/steps/hover-cases.html.
    private static func resolve(for m: NotchModel, state: NotchState, hovering: Bool) -> BarContent {
        // Feedback must remain visible at the surface where the action began.
        // Previously collapsed errors were logged and otherwise disappeared.
        if let toast = m.toast, !toast.isEmpty, !isExpandedState(state) {
            return BarContent(dot: .failed, left: "Couldn't complete", detail: toast, alarm: .failed)
        }
        // The expanded panels carry their own chrome — no shoulders to fill.
        if isExpandedState(state) { return BarContent() }

        // TWO FACTS, AT MOST. "What wants you" and "what is running" — resolved
        // first, PLACED second, because where each one goes depends on whether
        // the other exists.
        typealias Fact = (status: TaskStatus, label: String, count: Int?)
        var wants: Fact? = nil
        var runs: Fact? = nil

        if let a = m.agentActivity {
            // The Agent is one thing, so it never carries a count: "and N more
            // like this" is a lie about a single worker. An Agent that is
            // CONFIRMING has stopped running and started asking, so it changes
            // which fact it is — the placement rules below do the rest.
            let (status, label) = agentWords(a.state)
            if status.isYourMove { wants = (status, label, nil) } else { runs = (status, label, nil) }
        } else if m.capturePhase == "routing" {
            // ROUTING OUTRANKS EVERY RESTING STATE.
            //
            // Between the recording pill vanishing and the task appearing, the
            // router is deciding where the words go — an LLM call, so it is not
            // instant. The pill is gone by then and the task does not exist
            // yet, so the surface said nothing at all and the user was left
            // wondering whether their words had landed.
            runs = (.processing, "Sending", nil)
        } else if state != .dormant, let r = BarShoulders.running(m.working) {
            // DORMANT IS THE CUTOUT, so a count has nowhere to be drawn — and
            // the host only ever commands dormant when nothing is running. The
            // overrides above DO outrank dormant: each is a thing happening
            // right now that the user is waiting on a sign of.
            runs = (r.status, Theme.statusLabel(r.status), r.count)
        }

        // ONLY WHAT IS WAITING MAY SPEAK FROM THE CLOSED SURFACE. This once read
        // `taskCount`, i.e. every slot — so a pocket holding tasks you had merely
        // opened announced them in the your-move colour as though work were
        // waiting. That is exactly the way to teach someone to ignore the one
        // channel that matters.
        //
        // An OPEN pocket is excluded because it is drawing itself: the cards are
        // on screen, in front of you, already saying this.
        if wants == nil, !m.pocket.isOpen, let w = BarShoulders.wanting(m.pocket.slots) {
            wants = (w.status, Theme.statusLabel(w.status), w.count)
        }

        // ── WHERE THE FACTS GO: THE RIGHT SHOULDER FILLS FIRST ──
        //
        // One fact is drawn on the RIGHT with the mark keeping the left. The
        // left only takes a status when the right is already holding running
        // work. Filling the left first instead put a lone "Ready" against an
        // empty right half, which made the status word appear to change sides
        // depending on whether anything happened to be running — the left
        // shoulder alternating between identity and status with nothing in the
        // content to explain the swap.
        //
        // The glow follows the thing that WANTS you, whichever shoulder it
        // landed on. It is a property of the news, not of a position.
        var c = BarContent()
        switch (wants, runs) {
        case let (w?, r?):
            c.dot = w.status; c.left = w.label; c.badge = w.count; c.alarm = w.status
            c.rightDot = r.status; c.right = r.label; c.rightBadge = r.count
        case let (w?, nil):
            c.left = "unmute"; c.emphasis = .wordmark
            c.rightDot = w.status; c.right = w.label; c.rightBadge = w.count; c.alarm = w.status
        case let (nil, r?):
            c.left = "unmute"; c.emphasis = .wordmark
            c.rightDot = r.status; c.right = r.label; c.rightBadge = r.count
        case (nil, nil):
            break
        }
        guard c.right == nil else { return c }

        switch state {
        case .dormant:
            // Nothing. Not a hairline, not a sliver — an always-visible idle
            // indicator stops being an indicator.
            return BarContent()
        default:
            // OFF-NOTCH AND UNTOUCHED: a nub, not a nameplate.
            //
            // Idle exists because a display with no cutout has no landmark, so
            // the surface must stay findable. That is a much smaller job than a
            // full-height black bar with "unmute" written in it, which
            // announces the app on every screen it is not needed on. What is
            // required is somewhere to aim, not a signature.
            //
            // On a notched display idle keeps the mark — there the mass is
            // continuous with the hardware, so it reads as the notch saying
            // something rather than as a badge sitting on the desktop.
            //
            // NO HOVER TEXT EITHER. "Ready" cannot be borrowed here: it already
            // means a finished task awaiting you. The mark alone is the state.
            if !m.hasNotch && !hovering { return BarContent(resting: true) }
            return BarContent(left: "unmute", emphasis: .wordmark)
        }
    }

    /// The Agent's own vocabulary, mapped onto the shared one. Its states are
    /// not task states and never become tasks, but they are said in the same
    /// six words so the surface reads as one thing.
    private static func agentWords(_ s: AgentActivityState) -> (TaskStatus, String) {
        switch s {
        case .listening:  return (.processing, "Listening")
        case .searching:  return (.processing, "Searching")
        case .thinking:   return (.processing, "Thinking")
        case .confirming: return (.needsUser,  "Confirming")
        case .complete:   return (.done,       "Done")
        case .failed:     return (.failed,     "Couldn't complete")
        }
    }

    // `countPhrase` lived here — "Nothing running" / "N running". Both of its
    // callers are gone: idle never had a count to show, and active now says
    // "Working" with the number in the badge.
}
