import XCTest
@testable import ConversationSupport

final class ContentRetentionTests: XCTestCase {
    func testAcceptedDetailAcknowledgmentRestoresWithoutOverwritingAnotherQuestion() throws {
        let ack = try JSONDecoder().decode(ChatQuestionAcknowledgment.self, from: Data("{\"reference\":{\"requestId\":\"A\",\"stepId\":\"0\"},\"state\":\"accepted\"}".utf8))
        XCTAssertEqual(mergeChatAcknowledgment(current: nil, incoming: ack, displayed: nil)?.state, "accepted")
        let b = ChatQuestionReference(requestId: "B", stepId: "0")
        XCTAssertNil(mergeChatAcknowledgment(current: nil, incoming: ack, displayed: b))
        let pending = ChatQuestionAcknowledgment(reference: b, state: "pending")
        XCTAssertEqual(mergeChatAcknowledgment(current: pending, incoming: ack, displayed: nil)?.reference, b)
    }

    func testSelectedFolderCreationDoesNotRequireManagedAllocation() {
        XCTAssertTrue(canCreateChat(pending: false, folder: "/valid/project", hasManagedPreview: false))
        XCTAssertFalse(canCreateChat(pending: false, folder: nil, hasManagedPreview: false))
        XCTAssertFalse(canCreateChat(pending: true, folder: "/valid/project", hasManagedPreview: true))
    }

    func testLegacyRowsRetainCommandsAndUseSharedTurnPresentation() {
        let rows = ConversationPresentation.build([ConversationTurn(role: "user", text: "prompt"),
            ConversationTurn(role: "tool", text: "result", title: "Run", code: "echo x", output: "full output", ok: false)])
        let blocks = ConversationPresentation.blocks(from: rows)
        XCTAssertEqual(blocks.first?.text, "prompt")
        XCTAssertEqual(blocks.last?.output, "full output")
        XCTAssertEqual(BlockPresentation.build(blocks).last?.meta.status, "failed")
    }
    func testFullFileChangesAndToolResultsSurviveNativeDecode() throws {
        let text = String(repeating: "full output\n", count: 4000)
        let payload: [String: Any] = ["kind": "fileChange", "changes": [
            ["path": "/a", "verb": "Edited", "added": 1, "removed": 1, "diff": "-old\n+new"],
            ["path": "/b", "verb": "Added", "added": 1, "removed": 0, "diff": "+second"]]]
        let block = try JSONDecoder().decode(Block.self, from: JSONSerialization.data(withJSONObject: payload))
        let roundtrip = try JSONSerialization.jsonObject(with: JSONEncoder().encode(block)) as! [String: Any]
        XCTAssertEqual((roundtrip["changes"] as? [[String: Any]])?.count, 2)
        XCTAssertEqual(BlockPresentation.meta(of: [block]).files, 2)
        let tool = try JSONDecoder().decode(Block.self, from: JSONSerialization.data(withJSONObject: ["kind": "mcpCall", "status": "failed", "output": text, "error": "server refused"]))
        XCTAssertEqual(tool.output, text)
        XCTAssertEqual(BlockPresentation.meta(of: [tool]).status, "failed")
    }

    func testCancelledTurnDoesNotRemainRunningWhenDurationIsAbsent() throws {
        let blocks = try JSONDecoder().decode([Block].self, from: Data("[{\"kind\":\"turnStart\",\"startedAt\":1},{\"kind\":\"command\",\"status\":\"running\"},{\"kind\":\"turnEnd\",\"outcome\":\"cancelled\"}]".utf8))
        XCTAssertEqual(BlockPresentation.meta(of: blocks).status, "cancelled")
    }
    func testProviderStartBeforeUserMessageDoesNotCreateAnEmptyPreviousTurn() {
        let turns = BlockPresentation.build([Block(kind: "turnStart", startedAt: 1), Block(kind: "message", role: "user", text: "hello"),
            Block(kind: "message", role: "assistant", text: "answer"), Block(kind: "turnEnd", outcome: "completed")])
        XCTAssertEqual(turns.count, 1)
        XCTAssertEqual(turns.first?.reply?.text, "answer")
    }
}
