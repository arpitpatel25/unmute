import XCTest
@testable import ComposerSupport

// ⌘V into the task composer did nothing at all: the text box was focused, an
// image was on the pasteboard, and neither an attachment nor any text appeared
// — while the very same clipboard pasted fine into the terminal beside it.
//
// The decision of what a paste MEANS is separated from where it is delivered,
// so the rule can be stated once and asserted without AppKit.
final class ComposerPasteTests: XCTestCase {
    func testAnImageOnThePasteboardBecomesAnAttachment() {
        XCTAssertEqual(composerPasteAction(hasImage: true, hasText: false), .stageImage)
    }

    func testAnImageWinsOverTheTextFlavourThatRidesAlongWithIt() {
        // A screenshot tool often puts a filename or URL on the board beside the
        // bitmap. Pasting that filename as text is never what was meant.
        XCTAssertEqual(composerPasteAction(hasImage: true, hasText: true), .stageImage)
    }

    func testPlainTextStillPastesAsText() {
        XCTAssertEqual(composerPasteAction(hasImage: false, hasText: true), .insertText)
    }

    func testAnEmptyPasteboardDoesNothing() {
        XCTAssertEqual(composerPasteAction(hasImage: false, hasText: false), .nothing)
    }
}
