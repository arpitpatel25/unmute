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
}

public enum BannerRepeat {
    public static func landing(current: SurfaceRung) -> SuppressedBannerLanding {
        switch current {
        case .dormant:
            return .stayPut
        case .bar:
            // A flap arriving while the bar is up must settle, rather than
            // merely declining to re-arm the clock.
            return .restSilently
        case .expanded:
            // THE LINE THIS RULE EXISTED WITHOUT.
            //
            // A compact rung arriving while a task or the cockpit is open is
            // the engine reporting that nothing is engaged any more — which it
            // only ever says because the user dismissed the surface. Honour it.
            // Suppression may keep the bar quiet on the way down; it may not
            // keep the panel open.
            return .restSilently
        }
    }
}
