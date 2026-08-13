import Foundation

/// The only supported fills for an expanded surface.  Keeping this pure lets
/// the controller and its controls share the same bounds without owning a
/// second preference.
public enum SurfaceSizeStep {
    public enum Direction {
        case smaller
        case larger
    }

    public static let values: [CGFloat] = [0.7, 0.8, 0.9]

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

    public static func next(after fill: CGFloat, direction: Direction) -> CGFloat? {
        guard let index = values.firstIndex(where: { abs($0 - fill) < 0.001 }) else { return nil }
        switch direction {
        case .smaller:
            return index > values.startIndex ? values[index - 1] : nil
        case .larger:
            return index < values.index(before: values.endIndex) ? values[index + 1] : nil
        }
    }
}
