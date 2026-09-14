import XCTest
@testable import ConversationSupport

/// Task 12: the Swift side of routine chat blocks — decode, turn
/// presentation, and the "never running" rule for a routine turn.
///
/// Spec: docs/superpowers/specs/2026-09-14-agent-routines-design.md §5.
final class RoutineBlocksTests: XCTestCase {

    // MARK: - decode

    func testDecodesRoutineResultWithProposals() throws {
        let json = """
        {
          "kind": "routineResult", "at": 1700000005000, "startedAt": 1700000000000,
          "name": "Morning digest", "status": "done", "text": "Nothing urgent.",
          "what": "run-1", "path": "routine-1",
          "proposals": [
            { "id": "p1", "title": "Reply to Jane", "detail": "Draft a reply", "state": "pending" }
          ]
        }
        """
        let block = try JSONDecoder().decode(Block.self, from: Data(json.utf8))
        XCTAssertEqual(block.kind, "routineResult")
        XCTAssertEqual(block.at, 1700000005000)
        XCTAssertEqual(block.startedAt, 1700000000000)
        XCTAssertEqual(block.name, "Morning digest")
        XCTAssertEqual(block.status, "done")
        XCTAssertEqual(block.text, "Nothing urgent.")
        XCTAssertEqual(block.what, "run-1")
        XCTAssertEqual(block.path, "routine-1")
        XCTAssertEqual(block.proposals, [BlockProposal(id: "p1", title: "Reply to Jane", detail: "Draft a reply", state: "pending")])
    }

    // MARK: - presentation

    private func msg(_ role: String, _ text: String) -> Block {
        Block(kind: "message", role: role, text: text)
    }
    private func routineRun(_ what: String) -> Block {
        Block(kind: "routineRun", at: 1, status: "running", what: what, trigger: "Run now")
    }
    private func routineResult(_ what: String) -> Block {
        Block(kind: "routineResult", at: 2, text: "Done.", status: "done", path: "routine-1", name: "Digest", what: what, startedAt: 1)
    }

    // R4: [user, assistant, routineRun, routineResult] → 3 turns: (user+reply),
    // (routineRun prompt), (routineResult reply). Electron never produces the
    // order where a routineResult would need to attach a reply after a
    // routineRun's own standalone turn — routineRun and routineResult are
    // always their own separate turns, never merged with each other or with
    // surrounding message turns.
    func testRoutineRunAndResultFormStandaloneTurns() {
        let turns = BlockPresentation.buildTurns([
            msg("user", "how's it going"),
            msg("assistant", "all quiet"),
            routineRun("run-1"),
            routineResult("run-1"),
        ])

        XCTAssertEqual(turns.count, 3)

        XCTAssertEqual(turns[0].prompt?.text, "how's it going")
        XCTAssertEqual(turns[0].reply?.text, "all quiet")

        XCTAssertEqual(turns[1].prompt?.kind, "routineRun")
        XCTAssertNil(turns[1].reply)
        XCTAssertTrue(turns[1].work.isEmpty)

        XCTAssertNil(turns[2].prompt)
        XCTAssertEqual(turns[2].reply?.kind, "routineResult")
        XCTAssertTrue(turns[2].work.isEmpty)
    }

    // R4: routine turns never get marked running by build(_:running:), even
    // when one is the last turn in the list — a routineRun with no reply
    // looks exactly like an unanswered question to the ordinary rule, and a
    // routineResult reply-only turn looks exactly like a settled one either
    // way, so both need the explicit carve-out.
    func testRunningNeverAttachesToARoutineRunTurn() {
        let turns = BlockPresentation.build([routineRun("run-1")], running: true)
        XCTAssertEqual(turns.count, 1)
        XCTAssertNotEqual(turns[0].meta.status, "running")
    }

    func testRunningNeverAttachesToARoutineResultTurn() {
        let turns = BlockPresentation.build([
            msg("user", "hi"),
            routineRun("run-1"),
            routineResult("run-1"),
        ], running: true)

        XCTAssertEqual(turns.count, 3, "the unanswered user message, the routineRun and the routineResult are each their own turn")
        let last = turns[turns.count - 1]
        XCTAssertEqual(last.reply?.kind, "routineResult")
        XCTAssertNotEqual(last.meta.status, "running")
    }

    // MARK: - BlockKind

    func testRoutineKindsAreDrawable() {
        XCTAssertTrue(BlockKind.isDrawable("routineRun"))
        XCTAssertTrue(BlockKind.isDrawable("routineResult"))
    }

    // MARK: - stable id

    func testRoutineBlockIdKeysOnRunIdNotRoutineId() {
        let resultA = Block(kind: "routineResult", text: "x", status: "done", path: "routine-1", name: "Digest", what: "run-1")
        let resultB = Block(kind: "routineResult", text: "y", status: "done", path: "routine-1", name: "Digest", what: "run-2")
        XCTAssertNotEqual(resultA.id, resultB.id, "two runs of the same routine must not collide on id")
        XCTAssertEqual(resultA.id, "routineResult-run-1")
    }
}
