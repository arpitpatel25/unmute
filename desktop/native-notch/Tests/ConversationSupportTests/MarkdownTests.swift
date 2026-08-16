import XCTest
@testable import ConversationSupport

final class MarkdownTests: XCTestCase {

    // THE BUG THIS EXISTS FOR: Apple's inline markdown parser renders **bold**
    // and `code` but leaves "- item" and "## heading" as literal text, so every
    // agent answer arrived with visible dashes and hashes where Codex shows
    // dots and headings.

    func testABulletBecomesABulletRatherThanADash() {
        let b = Markdown.blocks("- Unmute does not replace coding agents.")
        XCTAssertEqual(b, [.bullet(text: "Unmute does not replace coding agents.", depth: 0)])
        XCTAssertEqual(Markdown.marker(depth: 0), "•")
    }

    func testNestingIsMeasuredFromIndentAndSwitchesGlyph() {
        // Codex renders depth 0 as `disc` and deeper as `circle`.
        let b = Markdown.blocks("- Major components are:\n  - Electron orchestration\n  - Native macOS paste")
        XCTAssertEqual(b, [
            .bullet(text: "Major components are:", depth: 0),
            .bullet(text: "Electron orchestration", depth: 1),
            .bullet(text: "Native macOS paste", depth: 1),
        ])
        XCTAssertEqual(Markdown.marker(depth: 1), "◦")
    }

    func testHeadingsAreParsedWithTheirLevel() {
        XCTAssertEqual(Markdown.blocks("## The shape"), [.heading(text: "The shape", level: 2)])
        XCTAssertEqual(Markdown.blocks("#### Detail"), [.heading(text: "Detail", level: 4)])
    }

    func testAHashWithNoTextIsNotAHeading() {
        XCTAssertEqual(Markdown.blocks("###"), [.paragraph("###")])
    }

    func testParagraphLinesAreJoinedIntoOneBlock() {
        // Hard-wrapped prose is one paragraph, not three, or it would render
        // with ragged breaks that have nothing to do with the panel's width.
        let b = Markdown.blocks("The core organizing concept\nis whose move is it.\n\nSecond para.")
        XCTAssertEqual(b, [
            .paragraph("The core organizing concept is whose move is it."),
            .paragraph("Second para."),
        ])
    }

    func testFencedCodeKeepsItsLinesAndLanguage() {
        let b = Markdown.blocks("before\n```json\n{\n  \"a\": 1\n}\n```\nafter")
        XCTAssertEqual(b, [
            .paragraph("before"),
            .code(text: "{\n  \"a\": 1\n}", language: "json"),
            .paragraph("after"),
        ])
    }

    func testBlankLinesInsideAFenceSurvive() {
        let b = Markdown.blocks("```\na\n\nb\n```")
        XCTAssertEqual(b, [.code(text: "a\n\nb", language: nil)])
    }

    func testAnUnclosedFenceStillYieldsItsContent() {
        // Streaming: the closing fence has not arrived yet. Losing the block
        // until it does would make code flicker in and out as it streams.
        let b = Markdown.blocks("```sh\nls -la")
        XCTAssertEqual(b, [.code(text: "ls -la", language: "sh")])
    }

    func testOrderedListsKeepTheirNumbers() {
        let b = Markdown.blocks("1. Dictation\n2. Remote")
        XCTAssertEqual(b, [
            .ordered(text: "Dictation", number: 1, depth: 0),
            .ordered(text: "Remote", number: 2, depth: 0),
        ])
    }

    func testAHorizontalRuleIsARule() {
        XCTAssertEqual(Markdown.blocks("a\n\n---\n\nb"), [.paragraph("a"), .rule, .paragraph("b")])
    }

    func testInlineMarkupIsLeftForTheInlinePass() {
        // Bold and code chips are what AttributedString is good at; this pass
        // must not mangle them on the way through.
        let b = Markdown.blocks("- `PROJECT.md` is **missing**")
        XCTAssertEqual(b, [.bullet(text: "`PROJECT.md` is **missing**", depth: 0)])
    }

    func testARealAnswerParsesIntoTheShapeCodexShows() {
        let source = """
        I've reviewed the private repository.

        My working understanding:

        - Unmute does not aim to replace coding agents.
        - Major components are:
          - Electron orchestration and provider routing
          - Swift/SwiftUI notch, wall, rail, pocket

        ## Documentation caveats
        """
        let b = Markdown.blocks(source)
        XCTAssertEqual(b.count, 7)
        XCTAssertEqual(b[0], .paragraph("I've reviewed the private repository."))
        XCTAssertEqual(b[3], .bullet(text: "Major components are:", depth: 0))
        XCTAssertEqual(b[4], .bullet(text: "Electron orchestration and provider routing", depth: 1))
        XCTAssertEqual(b[6], .heading(text: "Documentation caveats", level: 2))
    }

    func testEmptyInputYieldsNothing() {
        XCTAssertTrue(Markdown.blocks("").isEmpty)
        XCTAssertTrue(Markdown.blocks("\n\n  \n").isEmpty)
    }
}
