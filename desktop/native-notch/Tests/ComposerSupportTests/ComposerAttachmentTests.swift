import XCTest
@testable import ComposerSupport

final class ComposerAttachmentTests: XCTestCase {
    func testPasteThresholds() {
        XCTAssertFalse(shouldCollapseComposerPaste(String(repeating: "a", count: 899)))
        XCTAssertTrue(shouldCollapseComposerPaste(String(repeating: "a", count: 900)))
        XCTAssertTrue(shouldCollapseComposerPaste(String(repeating: "a", count: 901)))
        XCTAssertFalse(shouldCollapseComposerPaste(Array(repeating: "a", count: 11).joined(separator: "\n")))
        XCTAssertTrue(shouldCollapseComposerPaste(Array(repeating: "a", count: 12).joined(separator: "\n")))
        XCTAssertTrue(shouldCollapseComposerPaste(Array(repeating: "a", count: 13).joined(separator: "\n")))
    }
    func testPasteThresholdPolicyCanBeOverridden() {
        XCTAssertTrue(shouldCollapseComposerPaste("12345", policy: .init(characterThreshold: 5, lineThreshold: 3)))
        XCTAssertTrue(shouldCollapseComposerPaste("a\nb\nc", policy: .init(characterThreshold: 99, lineThreshold: 3)))
    }
    func testAttachmentsRejectFoldersAndOversizedFiles() {
        XCTAssertNotNil(composerAttachmentError(isRegularFile: false, byteCount: 1))
        XCTAssertNotNil(composerAttachmentError(isRegularFile: true, byteCount: 26 * 1024 * 1024))
        XCTAssertNil(composerAttachmentError(isRegularFile: true, byteCount: 1024))
    }
    func testProviderAttachmentPolicy() {
        XCTAssertNotNil(composerAttachmentError(isRegularFile: true, byteCount: 11 * 1024 * 1024, mimeType: "image/png"))
        XCTAssertNil(composerAttachmentError(isRegularFile: true, byteCount: 11 * 1024 * 1024, mimeType: "application/pdf"))
        XCTAssertNotNil(composerAttachmentError(isRegularFile: true, byteCount: 1, mimeType: "image/svg+xml"))
        XCTAssertNotNil(composerAttachmentError(isRegularFile: true, byteCount: 1, attachmentCount: 10))
        XCTAssertNotNil(composerAttachmentError(isRegularFile: true, byteCount: 2, totalBytes: 50 * 1024 * 1024))
        XCTAssertNil(composerAttachmentError(isRegularFile: true, byteCount: 1, mimeType: "image/webp", attachmentCount: 9))
    }
}
