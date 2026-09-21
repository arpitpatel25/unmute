import XCTest
import AppKit
@testable import ComposerSupport

final class ComposerEditorIntegrationTests: XCTestCase {
    func testWebPOnlyCopyPayloadPastesThroughActualEditor() {
        let board = NSPasteboard(name: .init("unmute-webp-test-\(UUID())"))
        defer { board.releaseGlobally() }
        let bytes = Data(base64Encoded: "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")!
        board.setData(bytes, forType: .init("org.webmproject.webp"))
        let editor = AttachmentTextView(); editor.composerPasteboard = board; editor.stagingTaskId = "webp"
        let delivered = expectation(description: "WebP bytes captured and decoded in worker")
        editor.onImagePaste = { path, mime, _, _, _, _ in
            XCTAssertEqual(mime, "image/png"); XCTAssertNotNil(NSImage(contentsOfFile: path))
            disposeComposerHandoff(path); delivered.fulfill()
        }
        XCTAssertTrue(editor.stagePasteboardImage())
        board.clearContents(); board.setString("replacement", forType: .string)
        wait(for: [delivered], timeout: 3)
    }
    func testImagePasteCapturesBytesBeforePasteboardChanges() {
        let board = NSPasteboard(name: .init("unmute-image-test-\(UUID())"))
        defer { board.releaseGlobally() }
        let bytes = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC")!
        board.setData(bytes, forType: .png)
        let editor = AttachmentTextView(); editor.composerPasteboard = board; editor.stagingTaskId = "image"
        let delivered = expectation(description: "captured image survives clipboard replacement")
        editor.onImagePaste = { path, mime, _, _, _, _ in
            XCTAssertEqual(mime, "image/png")
            XCTAssertNotNil(NSImage(contentsOfFile: path))
            disposeComposerHandoff(path); delivered.fulfill()
        }
        XCTAssertTrue(editor.stagePasteboardImage())
        board.clearContents(); board.setString("new clipboard", forType: .string)
        wait(for: [delivered], timeout: 3)
    }

    func testActualEditorUsesInjectedPastePolicy() {
        let board = NSPasteboard(name: .init("unmute-policy-test-\(UUID())"))
        defer { board.releaseGlobally() }
        board.setString("four", forType: .string)
        let editor = AttachmentTextView()
        editor.composerPasteboard = board
        editor.pastePolicy = .init(characterThreshold: 4, lineThreshold: 99)
        editor.stagingTaskId = "policy"
        let delivered = expectation(description: "policy collapses actual paste")
        editor.onImagePaste = { path, mime, _, _, _, _ in
            XCTAssertEqual(mime, "text/x-unmute-paste")
            XCTAssertEqual(try? String(contentsOfFile: path), "four")
            disposeComposerHandoff(path); delivered.fulfill()
        }
        editor.paste(nil)
        XCTAssertEqual(editor.string, "")
        wait(for: [delivered], timeout: 3)
    }

    func testAgentLargePasteRemainsLiteralTextInsteadOfAnUnsupportedAttachment() {
        let board = NSPasteboard(name: .init("unmute-agent-paste-test-\(UUID())"))
        defer { board.releaseGlobally() }
        let pasted = "a large pasted value"
        board.setString(pasted, forType: .string)
        let editor = AttachmentTextView()
        editor.composerPasteboard = board
        editor.pastePolicy = .init(characterThreshold: 1, lineThreshold: 1)
        editor.stagingTaskId = "unmute-agent"
        let staged = expectation(description: "Agent paste must not stage an attachment")
        staged.isInverted = true
        editor.onImagePaste = { _, _, _, _, _, _ in staged.fulfill() }

        editor.paste(nil)

        XCTAssertEqual(editor.string, pasted)
        wait(for: [staged], timeout: 0.1)
    }

    func testOldTaskCompletionCannotRegisterUndoIntoReusedEditor() {
        final class Editor: AttachmentTextView {
            let manager = UndoManager()
            override var undoManager: UndoManager? { manager }
        }
        let editor = Editor(), board = NSPasteboard(name: .init("unmute-undo-test-\(UUID())"))
        defer { board.releaseGlobally() }
        board.setString("attachment", forType: .string)
        editor.composerPasteboard = board; editor.pastePolicy = .init(characterThreshold: 1, lineThreshold: 1)
        editor.stagingTaskId = "old"
        let delivered = expectation(description: "old task still receives content")
        editor.onImagePaste = { path, _, _, _, _, _ in disposeComposerHandoff(path); delivered.fulfill() }
        editor.onAttachmentUndo = { _, _ in XCTFail("old undo must not run") }
        editor.paste(nil); editor.stagingTaskId = "new"
        wait(for: [delivered], timeout: 3)
        XCTAssertFalse(editor.manager.canUndo)
    }

    // 2026-09-21 crash: dictated text into a task's composer, the card closed,
    // ⌘Z then invoked an undo whose target had been freed. The window's undo
    // manager does not retain targets, so an editor leaving must clear it.
    func testEditorLeavingTheWindowTakesItsUndoHistoryWithIt() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200),
                              styleMask: [.titled], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        let editor = AttachmentTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 200))
        editor.allowsUndo = true
        window.contentView?.addSubview(editor)
        editor.insertText("dictated words", replacementRange: NSRange(location: NSNotFound, length: 0))
        editor.breakUndoCoalescing()
        XCTAssertTrue(window.undoManager?.canUndo == true)
        editor.removeFromSuperview()
        XCTAssertFalse(window.undoManager?.canUndo == true)
    }

    func testEditorMovingWithinTheWindowKeepsItsUndoHistory() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200),
                              styleMask: [.titled], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        let host = NSView(frame: window.contentView!.bounds)
        window.contentView?.addSubview(host)
        let editor = AttachmentTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 200))
        editor.allowsUndo = true
        window.contentView?.addSubview(editor)
        editor.insertText("kept", replacementRange: NSRange(location: NSNotFound, length: 0))
        editor.breakUndoCoalescing()
        host.addSubview(editor)
        XCTAssertTrue(window.undoManager?.canUndo == true)
    }

    func testStagingAcknowledgmentPrunesJobsAndAdmissionNeverEvictsPendingContent() {
        let store = ComposerStagingStore(maxActive: 1)
        let gate = DispatchSemaphore(value: 0)
        let delivered = expectation(description: "delivered")
        let first = store.reserve(task: "a", name: "one", sourcePath: nil,
            work: { gate.wait(); return ("/not-private", "text/plain", "one") }, deliver: { _, _ in delivered.fulfill() })!
        XCTAssertNil(store.reserve(task: "b", name: "two", sourcePath: nil,
            work: { XCTFail("refused work started"); return ("", "", "") }, deliver: { _, _ in }))
        XCTAssertEqual(store.items(task: "a").map(\.id), [first])
        gate.signal(); wait(for: [delivered], timeout: 3)
        XCTAssertTrue(store.blocksSend(task: "a", attachmentIds: []))
        store.reconcile(task: "a", attachmentIds: [first])
        XCTAssertTrue(store.items(task: "a").isEmpty)
    }

    func testMissingPreviewFinishesUnavailableWithActionsDisabled() {
        let preview = ComposerAttachmentPreview()
        let loaded = expectation(description: "preview settled")
        preview.load(path: "/missing/\(UUID()).png", mime: "image/png") { loaded.fulfill() }
        XCTAssertFalse(preview.canUse)
        wait(for: [loaded], timeout: 3)
        XCTAssertFalse(preview.canUse)
        XCTAssertFalse(preview.loading)
        XCTAssertNil(preview.image)
    }
}
