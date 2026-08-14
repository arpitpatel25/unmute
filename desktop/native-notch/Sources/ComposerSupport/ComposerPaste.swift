// WHAT A ⌘V INTO THE TASK COMPOSER MEANS.
//
// Pasting an image into the composer did nothing at all — text box focused,
// image on the pasteboard, no attachment and no text — while the same
// clipboard pasted fine into the terminal an inch away. Two views, one
// clipboard, opposite results.
//
// The decision is separated from the delivery so it can be stated once and
// tested without AppKit, and so the ⌘V key-equivalent path and the NSTextView
// paste override cannot disagree about it — they ask the same question.

/// What a paste should do, given what the pasteboard is carrying.
public enum ComposerPasteAction: Equatable {
    /// Stage the bitmap as a draft attachment.
    case stageImage
    /// Ordinary text paste, handled by the text view itself.
    case insertText
    /// Nothing worth pasting.
    case nothing
}

/// AN IMAGE WINS OVER THE TEXT THAT RIDES WITH IT.
///
/// A screenshot usually arrives with a filename or file URL on the board beside
/// the bitmap, and pasting that string into the composer is never what the user
/// meant — they meant the picture.
public func composerPasteAction(hasImage: Bool, hasText: Bool) -> ComposerPasteAction {
    if hasImage { return .stageImage }
    return hasText ? .insertText : .nothing
}
