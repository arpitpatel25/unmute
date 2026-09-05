import Foundation

public enum ChatSurfaceSize {
    public static func bound(_ proposed: CGSize, screen: CGSize, expanded: Bool = false) -> CGSize {
        CGSize(width: min(proposed.width, expanded ? 1320 : 1040, max(0, screen.width - 24)),
               height: min(proposed.height, 860, max(0, screen.height - 24)))
    }
}
