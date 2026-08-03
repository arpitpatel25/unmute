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
    var right: String? = nil
    /// "and N more like this" — only ever drawn when it is greater than 1.
    var badge: Int? = nil
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
    static let gap: CGFloat = 7
    /// The wordmark is tracked out; tracking is width and has to be counted.
    static let wordmarkTracking: CGFloat = 2.1

    static let wordmarkSize: CGFloat = 9.5
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
        var w = Self.inset
        if dot != nil { w += Self.dotSize + Self.gap }
        if let t = left, !t.isEmpty {
            w += emphasis == .wordmark
                ? Self.measure(t, Self.wordmarkFont, tracking: Self.wordmarkTracking)
                : Self.measure(t, Self.statusFont)
        }
        if let b = badge, b > 1 { w += Self.gap + Self.badgeWidth(b) }
        return ceil(w + Self.gap)
    }

    /// Width the right half WANTS. What it gets is decided by the screen —
    /// see NotchGeometry.mass.
    var wantsRightWidth: CGFloat {
        guard let t = right, !t.isEmpty else { return 0 }
        return ceil(Self.gap + Self.measure(t, Self.detailFont) + Self.inset)
    }

    /// The count badge: two digits at most before it stops being a count.
    static func badgeWidth(_ n: Int) -> CGFloat {
        ceil(measure("\(n)", NSFont.systemFont(ofSize: 9.5, weight: .semibold)) + 12)
    }

    var isEmpty: Bool { dot == nil && (left?.isEmpty != false) && (right?.isEmpty != false) }

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
        // ROUTING OUTRANKS EVERY RESTING STATE.
        //
        // Between the recording pill vanishing and the task appearing, the
        // router is deciding where the words go — an LLM call, so it is not
        // instant. The pill is gone by then and the task does not exist yet, so
        // the surface said nothing at all and the user was left wondering
        // whether their words had landed.
        //
        // The phase is already broadcast (`broadcastCapturePhase('routing')` in
        // remote/init.ts, inside a try/finally so it always clears). It was only
        // ever rendered inside the expanded wall, where nobody is looking at
        // that moment. This is that same signal, at bar level.
        if m.capturePhase == "routing", !isExpandedState(state) {
            return BarContent(dot: .processing, left: "creating task", emphasis: .status)
        }
        switch state {
        case .dormant:
            // Nothing. Not a hairline, not a sliver — an always-visible idle
            // indicator stops being an indicator.
            return BarContent()

        case .idle:
            // OFF-NOTCH AND UNTOUCHED: a nub, not a nameplate.
            //
            // Idle here exists because a display with no cutout has no landmark,
            // so the surface must stay findable. That is a much smaller job than
            // it was being given: a full-height black bar with "unmute" written
            // in it announces the app on every screen it is not needed on. What
            // is required is somewhere to aim, not a signature.
            //
            // On a notched display idle keeps the wordmark — there the mass is
            // continuous with the hardware, so it reads as the notch saying
            // something rather than as a badge sitting on the desktop.
            if !m.hasNotch && !hovering { return BarContent(resting: true) }
            // One segment: there is no second thing to say. Hovering adds the
            // count, which is the answer to the only question idle raises.
            var c = BarContent(left: "unmute", emphasis: .wordmark)
            if hovering { c.right = countPhrase(m.working) }
            return c

        case .active:
            var c = BarContent(dot: .processing,
                               left: countPhrase(m.working),
                               emphasis: .status)
            // Left is the count; right is what is actually happening. Hovering a
            // running task shows its NAME, which is the one thing the activity
            // line does not carry.
            if let t = m.task {
                c.right = hovering ? t.title : (t.activity ?? t.title)
            }
            return c

        case .attention:
            let status = m.task?.status ?? .needsUser
            var c = BarContent(dot: status,
                               left: Theme.statusLabel(status),
                               emphasis: .status,
                               badge: m.attention,
                               alarm: status)
            c.right = m.task.map { t in t.question?.text ?? t.activity ?? t.title }
            return c

        case .task, .cockpit:
            // The expanded panel carries its own chrome.
            return BarContent()
        }
    }

    static func countPhrase(_ n: Int) -> String {
        switch n {
        case 0:  return "Nothing running"
        case 1:  return "1 running"
        default: return "\(n) running"
        }
    }
}
