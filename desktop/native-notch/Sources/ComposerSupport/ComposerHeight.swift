import CoreGraphics

public enum ComposerHeight {
    public static func resolve(measured: CGFloat) -> CGFloat {
        min(max(measured + 4, 30), 144)
    }
}
