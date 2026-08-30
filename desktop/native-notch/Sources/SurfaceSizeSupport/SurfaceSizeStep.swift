import Foundation

/// The only supported fills for an expanded surface.  Keeping this pure lets
/// the controller and its controls share the same bounds without owning a
/// second preference.
public enum SurfaceSizeStep {
    public enum Direction {
        case smaller
        case larger
    }

    /// THE RANGE, and why it stops where it does.
    ///
    /// This was three fixed buttons — 70/80/90 — which is a narrow band offered
    /// as a choice between three. What people actually do is drag to the size
    /// that suits the screen in front of them, so every value between the ends
    /// is reachable now.
    ///
    /// 95 rather than 100: an expanded surface edge-to-edge leaves no ground
    /// around it, and the notch is deliberately an overlay rather than a
    /// window. 40 rather than lower: below that the task view cannot hold a
    /// readable column and a terminal at the same time.
    public static let minimum: CGFloat = 0.40
    public static let maximum: CGFloat = 0.95

    /// Where a value nobody can interpret lands. Not the minimum — a surface
    /// that shrank to its floor because of a bad number reads as breakage.
    public static let fallback: CGFloat = 0.80

    /// One press of a nudge (the keyboard path, and the smaller/larger steps).
    public static let nudge: CGFloat = 0.05

    /// Bring any number into the range, at the resolution a person can see.
    ///
    /// WHOLE PERCENTS. A drag produces 0.7234, and "72.34%" is noise on a
    /// label — worse, it makes two visually identical surfaces compare
    /// unequal. NaN cannot be ordered, so it is answered before the clamp.
    public static func clamp(_ fill: CGFloat) -> CGFloat {
        guard fill.isNaN == false else { return fallback }
        let bounded = min(max(fill, minimum), maximum)
        return (bounded * 100).rounded() / 100
    }

    /// Position on the track, 0 at the left end and 1 at the right.
    public static func fraction(of fill: CGFloat) -> CGFloat {
        (clamp(fill) - minimum) / (maximum - minimum)
    }

    /// The fill at a position on the track. A drag runs past both ends — the
    /// pointer keeps moving after the track stops — so this clamps rather than
    /// extrapolating.
    public static func fill(atFraction fraction: CGFloat) -> CGFloat {
        guard fraction.isNaN == false else { return fallback }
        return clamp(minimum + (maximum - minimum) * min(max(fraction, 0), 1))
    }

    /// A visit-scoped choice is an absolute share of the screen, exactly like
    /// Settings → Appearance. Provider-specific defaults apply only until the
    /// user makes a temporary choice.
    public static func resolvedSize(
        screen: CGSize,
        providerDefault: CGSize,
        temporaryFill: CGFloat?
    ) -> CGSize {
        guard let fill = temporaryFill else { return providerDefault }
        return CGSize(width: round(screen.width * fill), height: round(screen.height * fill))
    }

    /// One nudge along the range, or nil at the end that direction points at.
    ///
    /// SNAPS TO THE GRID FIRST, so nudging from a dragged 0.72 lands on 0.75
    /// rather than carrying the dragged remainder along forever. The last step
    /// is short by design: from 0.93 a full nudge would overshoot the maximum,
    /// and refusing to move would strand the user just below the top.
    public static func next(after fill: CGFloat, direction: Direction) -> CGFloat? {
        // IN WHOLE PERCENTS, not in fractions. 0.70 / 0.05 is 13.999999999999998
        // in binary floating point, so flooring it gives 13 and a "nudge" from
        // 0.70 returned 0.70 — a control that visibly did nothing. The values
        // here are percents by nature; integers say so and cannot drift.
        let step = Int((nudge * 100).rounded())
        let low = Int((minimum * 100).rounded())
        let high = Int((maximum * 100).rounded())
        let here = Int((clamp(fill) * 100).rounded())

        switch direction {
        case .smaller:
            guard here > low else { return nil }
            let grid = ((here + step - 1) / step) * step          // up to the grid
            let target = grid == here ? here - step : grid - step
            return clamp(CGFloat(max(target, low)) / 100)
        case .larger:
            guard here < high else { return nil }
            let grid = (here / step) * step                        // down to the grid
            let target = grid == here ? here + step : grid + step
            return clamp(CGFloat(min(target, high)) / 100)
        }
    }
}
