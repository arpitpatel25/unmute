import XCTest
@testable import MarkdownSupport

/// The classifier's whole value is that it NEVER consults a brand table, so the
/// cases that matter most are the ones a brand table would get wrong: an unknown
/// host, and a link to a machine that is not this one.
final class LinkGlyphTests: XCTestCase {
    /// Nothing exists, so a path can only be judged by its shape. Keeps the
    /// tests independent of whatever happens to be on the disk running them.
    private let nothingExists: (String) -> Bool = { _ in false }

    func testSchemes() {
        XCTAssertEqual(linkKind(for: "mailto:a@b.com", isDirectory: nothingExists), .mail)
        XCTAssertEqual(linkKind(for: "MAILTO:A@B.COM", isDirectory: nothingExists), .mail)
        XCTAssertEqual(linkKind(for: "tel:+15551234", isDirectory: nothingExists), .phone)
        XCTAssertEqual(linkKind(for: "sms:+15551234", isDirectory: nothingExists), .phone)
    }

    /// THE POINT OF THE WHOLE DESIGN: a household name and a domain nobody has
    /// heard of are treated identically, because we classify links, not brands.
    func testEveryWebHostIsEqual() {
        for url in [
            "https://www.youtube.com/watch?v=iYlODtkyw_I",
            "https://github.com/apple/swift-markdown",
            "http://some-obscure-thing.example.co.uk/x",
        ] {
            XCTAssertEqual(linkKind(for: url, isDirectory: nothingExists), .web, url)
        }
    }

    /// A `.png` in a URL is still a web link — the image case is about local
    /// files. Guards against matching on extension before scheme.
    func testRemoteImageUrlIsStillWeb() {
        XCTAssertEqual(linkKind(for: "https://example.com/a.png", isDirectory: nothingExists), .web)
    }

    func testLocalFilesAndFolders() {
        XCTAssertEqual(linkKind(for: "/Users/x/notes.txt", isDirectory: nothingExists), .file)
        XCTAssertEqual(linkKind(for: "/Users/x/shot.PNG", isDirectory: nothingExists), .image)
        // The filesystem says directory even though the name looks like a file.
        XCTAssertEqual(linkKind(for: "/Users/x/sessions", isDirectory: { $0 == "/Users/x/sessions" }), .folder)
        // …and a trailing slash is believed WITHOUT the filesystem, so a path on
        // someone else's machine still reads as a folder.
        XCTAssertEqual(linkKind(for: "/not/on/this/mac/", isDirectory: nothingExists), .folder)
    }

    func testFileUrlsAndTilde() {
        XCTAssertEqual(linkKind(for: "file:///Users/x/notes.txt", isDirectory: nothingExists), .file)
        XCTAssertEqual(linkKind(for: "file:///Users/a%20b/c.png", isDirectory: nothingExists), .image)
        // Agents write `~/.codex/sessions` constantly; unexpanded it would be
        // handed to isDirectory as a literal `~/…` and never match.
        let home = NSHomeDirectory()
        XCTAssertEqual(
            linkKind(for: "~/.codex/sessions", isDirectory: { $0 == "\(home)/.codex/sessions" }),
            .folder)
    }

    func testDegenerateInput() {
        XCTAssertEqual(linkKind(for: "", isDirectory: nothingExists), .web)
        XCTAssertEqual(linkKind(for: "   ", isDirectory: nothingExists), .web)
        // Relative paths are not resolvable from here, so they stay .web rather
        // than being guessed at against the wrong working directory.
        XCTAssertEqual(linkKind(for: "docs/readme.md", isDirectory: nothingExists), .web)
    }
}
