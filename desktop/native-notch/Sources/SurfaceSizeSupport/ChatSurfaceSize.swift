import Foundation

public enum ChatSurfaceSize {
    public static func bound(_ proposed: CGSize, screen: CGSize, expanded: Bool = false) -> CGSize {
        // Dashboard and task chat share one size policy, including empty dashboards.
        CGSize(width: min(proposed.width, 1040, max(0, screen.width - 24)),
               height: min(proposed.height, 860, max(0, screen.height - 24)))
    }
}
