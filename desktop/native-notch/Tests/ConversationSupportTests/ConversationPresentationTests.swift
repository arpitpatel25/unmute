import XCTest
@testable import ConversationSupport

final class ConversationPresentationTests: XCTestCase {
    func testGroupsAConversationIntoStableVisualRows() {
        let turns = [
            ConversationTurn(role: "user", text: "question"),
            ConversationTurn(role: "work", text: "", durationMs: 1200),
            ConversationTurn(role: "tool", text: "searched", title: "Search"),
            ConversationTurn(role: "commentary", text: "checking"),
            ConversationTurn(role: "assistant", text: "answer"),
        ]

        let rows = ConversationPresentation.build(turns)

        XCTAssertEqual(rows.map(\.id), ["user-0", "work-1", "answer-4"])
        XCTAssertEqual(rows[1].workItems.count, 2)
        XCTAssertEqual(rows.markdownTexts, ["answer"])
    }

    func testAppendingTurnsKeepsExistingRowIdentity() {
        let original = [
            ConversationTurn(role: "user", text: "question"),
            ConversationTurn(role: "assistant", text: "answer"),
        ]
        let before = ConversationPresentation.build(original)
        let after = ConversationPresentation.build(original + [
            ConversationTurn(role: "user", text: "follow up")
        ])

        XCTAssertEqual(Array(after.prefix(2)).map(\.id), before.map(\.id))
    }

}
