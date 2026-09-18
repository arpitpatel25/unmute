/// Where the surface lands when its banner has NOTHING NEW TO SAY.
///
/// The notch suppresses a repeat announcement, and rightly: the same task
/// reporting again every few seconds is the engine talking to itself, not news
/// to the person watching. But that decision is about whether the bar SPEAKS.
/// It is not — and was never meant to be — a decision about whether the surface
/// MOVES. The two were one inline `if` in the state-command handler, and they
/// got conflated. Twice.
///
/// FIRST: a suppressed banner skipped the departure settlement, so a surface
/// hidden by a screen lock never came back (fixed in 0ae14c90, six hours off
/// screen in the field).
///
/// SECOND, and why this rule now lives here: the fallback was written as
/// `if model.state != .dormant, !isExpanded(model.state) { applyState(.dormant) }`
/// — correct for the ambient repeat it was written for, silently wrong for the
/// OTHER command that reaches it. Dismissing an expanded surface makes the
/// engine command a compact rung (`active`/`attention`) for a task it has
/// already announced, so the suppression fired, that guard refused, and the
/// transition was dropped on the floor. Click outside the expanded notch and
/// nothing happened. Escape from the background did nothing, for exactly the
/// same reason — it is one bug, not two. Field log 17 Sep 20:51:27: two clicks
/// outside and an Escape, three `banner: SUPPRESS` lines, and no `state ->`
/// line after any of them.
///
/// Split out for the reason the other support modules were: the rule IS the
/// behaviour, and a wrong one is invisible in a diff.
public enum SurfaceRung: Equatable, Sendable {
    /// Hidden in the cutout.
    case dormant
    /// Bar level — idle, active, attention.
    case bar
    /// Task or cockpit. The user opened this.
    case expanded
}

public enum SuppressedBannerLanding: Equatable, Sendable {
    /// Already at rest. There is nothing to move.
    case stayPut
    /// Come down WITHOUT announcing. The caller keeps the suppressed rung in
    /// `restedFrom`, so hovering still answers the only question a quiet notch
    /// raises: is anything waiting on me?
    case restSilently
    /// Come down out of the expanded surface, and STOP AT THE BAR. The
    /// dismissal is honoured; the open pocket below it is not swallowed on the
    /// way past. See `SurfaceRest`.
    case settleAtBar
}

/// MAY THE SURFACE PUT *ITSELF* DOWN?
///
/// Every self-initiated rest asks this — the two-second banner clock, a
/// suppressed repeat, the hover ladder — and until now each answered it on its
/// own, which is why they disagreed. `HoverSleepPolicy` knew an explicitly open
/// pocket must never sleep; the other two did not, and on a notched Mac that is
/// not a subtle difference:
///
///   DORMANT IS THE CUTOUT. `NotchGeometry.dormantFrame()` is the hole itself
///   (183x32 on a 14" MBP), so a surface resting with the pocket open does not
///   go quiet — it is posted BEHIND THE CAMERA HOUSING, where there is no
///   screen. The card the user just clicked for is simply gone about a second
///   later, and the only way back is to click again. Field log 18 Sep 20:20:41:
///   click, `state -> attention w=348 h=150`, one second, `rest: attention ->
///   dormant w=183 h=32`, then `hover-reveal: dormant -> attention` when the
///   user went back for it. Off-notch the same command lands on `.idle`
///   (applyState maps it, there being no cutout to hide in) and the pocket
///   stays visible — which is exactly why this only ever happened on the Macs
///   with a notch.
///
/// The engine COMMANDING dormant is a different question and not this one: main
/// pairs `pocket open` with `setState dormant` on Escape, and an explicit
/// command outranks anything the surface decides for itself.
///
/// So this answers ONE question: is anything HOLDING THE SURFACE UP? Whether
/// there is anything to move (there is not, at `.dormant`) stays the caller's
/// own business — the stand-down clock still has bookkeeping to do down there.
public enum SurfaceRest {
    public static func mayRest(current: SurfaceRung, pocketOpen: Bool) -> Bool {
        // An explicit pocket is USER STATE, not hover state, and never
        // participates in the dormant ladder — the same rule HoverSleepPolicy
        // applies to the pointer, stated once for every caller.
        guard !pocketOpen else { return false }
        // A panel the user opened is not ours to collapse. (The engine
        // RELAYING a dismissal is a different matter — see BannerRepeat.)
        return current != .expanded
    }
}

public enum BannerRepeat {
    public static func landing(current: SurfaceRung, pocketOpen: Bool) -> SuppressedBannerLanding {
        // AN OPEN POCKET ENDS UP WHERE IT CAN BE SEEN, wherever it is now.
        //
        // The bar is the only rung that can show it: the cutout has no room and
        // a panel outranks it. So from dormant that means coming UP, from a
        // panel it means coming DOWN, and at the bar it is already there.
        //
        // The up direction is the one this rule was missing, and the chord is
        // how you meet it: Right Command + Right Option is pressed with the
        // surface at rest — you press it to go and look, not because something
        // called you. The pocket opens into the cutout, the engine commands the
        // compact rung that would lift it out, that rung is a repeat, and
        // suppression said "already dormant, nothing to move". Field log 19 Sep
        // 03:26:47: four and a half seconds in the hole, until the pointer went
        // looking for it.
        if pocketOpen { return current == .bar ? .stayPut : .settleAtBar }
        // Nothing to move, and nothing being hidden by staying put.
        if current == .dormant { return .stayPut }
        // THE LINE THIS RULE EXISTED WITHOUT.
        //
        // A compact rung arriving while a task or the cockpit is open is the
        // engine reporting that nothing is engaged any more — which it only
        // ever says because the user dismissed the surface. Honour it.
        // Suppression may keep the bar quiet on the way down; it may not keep
        // the panel open. Everything still up settles, rather than merely
        // declining to re-arm the clock.
        return .restSilently
    }
}


/// IS `.dormant` A STATE THIS SURFACE MAY ACTUALLY OCCUPY?
///
/// Dormant is not a rung like the others. It is a PLACE — the camera cutout —
/// and the surface only gets to use it when that place exists and is empty.
/// Two conditions, and they used to live apart: one inline in `applyState`, the
/// other nowhere at all.
///
///   NO CUTOUT, NO DORMANT. On a display without a notch, dormant reserved a
///   2pt strip at dead centre, findable only by accident. The notch is a
///   CONTROL as well as an indicator; an indicator may hide when it has nothing
///   to say, a control may not. Off-notch, dormant is `.idle`: quiet, small,
///   never glowing, but always there and always a target.
///
///   AN OPEN POCKET OCCUPIES IT. The card the user just asked for is drawn at
///   bar level, and dormant would post it behind the housing where there is no
///   screen. This is not the surface's own rest decision (see `SurfaceRest`) —
///   it is a rung the ENGINE commands, from the one line in reconcile that says
///   "nothing is processing". That is a fact about tasks, not about whether
///   anything is on screen, and the pocket is exactly where the two come apart.
///   The engine no longer conflates them; this is the surface refusing to be
///   hidden even if something else ever does.
public enum DormantAvailability {
    public static func available(hasNotch: Bool, pocketOpen: Bool) -> Bool {
        hasNotch && !pocketOpen
    }
}
