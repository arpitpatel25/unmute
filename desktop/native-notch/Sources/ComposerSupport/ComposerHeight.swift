import CoreGraphics

public enum ComposerHeight {
    public static func resolve(measured: CGFloat) -> CGFloat {
        min(max(measured + 4, 30), 144)
    }

    /// Top/bottom inset that centres the text in the frame `resolve` gives it.
    ///
    /// A single line is far shorter than the 30pt minimum, and drawn from the
    /// top it sat visibly above the + and send buttons beside it. Centring it
    /// is what a chat field does; once the text outgrows the minimum the inset
    /// settles at the same 2pt the +4 already allowed, so tall drafts are
    /// unchanged. `lineHeight` covers an empty draft, which measures as 0.
    public static func verticalInset(measured: CGFloat, lineHeight: CGFloat) -> CGFloat {
        let content = max(measured, lineHeight)
        return max(2, ((resolve(measured: content) - content) / 2).rounded(.down))
    }
}
