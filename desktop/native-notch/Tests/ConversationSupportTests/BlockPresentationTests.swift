import XCTest
@testable import ConversationSupport

final class BlockPresentationTests: XCTestCase {

    private func msg(_ role: String, _ text: String) -> Block {
        Block(kind: "message", role: role, text: text)
    }
    private func cmd(_ command: String, status: String = "ok") -> Block {
        Block(kind: "command", label: "Ran command", command: command, status: status)
    }
    private func file(_ path: String, _ added: Int, _ removed: Int) -> Block {
        Block(kind: "fileChange", path: path, verb: "Edited", added: added, removed: removed)
    }

    // MARK: - the open rule

    // A kind this build does not know must decode and draw as a plain row. The
    // branch this replaces turned anything unrecognised into an ANSWER BUBBLE,
    // so an unknown row read as the agent having said something it never said.
    func testAnUnknownKindIsNotDrawnAsAMessage() throws {
        let json = #"{"kind":"holographicDiff","raw":"{}"}"#.data(using: .utf8)!
        let block = try JSONDecoder().decode(Block.self, from: json)
        XCTAssertEqual(block.kind, "holographicDiff")
        XCTAssertFalse(block.isMessage)
        XCTAssertFalse(BlockKind.isDrawable(block.kind))
    }

    func testDecodingSurvivesFieldsThisBuildHasNeverSeen() throws {
        // The Electron side ships ahead of this binary on any release where the
        // two move at different speeds. One unknown field must not empty the panel.
        let json = #"{"kind":"command","command":"ls","status":"ok","quantumFlux":42}"#.data(using: .utf8)!
        let block = try JSONDecoder().decode(Block.self, from: json)
        XCTAssertEqual(block.command, "ls")
    }

    func testAnUnknownKindStillGroupsAsWork() {
        let turns = BlockPresentation.build([
            msg("user", "q"),
            Block(kind: "futureThing", raw: "{}"),
            msg("assistant", "a"),
        ])
        XCTAssertEqual(turns.count, 1)
        XCTAssertEqual(turns[0].work.count, 1)
    }

    // MARK: - turns

    func testAThreadSplitsIntoOneGroupPerTurn() {
        let turns = BlockPresentation.build([
            msg("user", "first"), cmd("echo one"), msg("assistant", "reply one"),
            msg("user", "second"), cmd("echo two"), cmd("echo three"), msg("assistant", "reply two"),
        ])
        XCTAssertEqual(turns.count, 2)
        XCTAssertEqual(turns[0].work.count, 1)
        XCTAssertEqual(turns[1].work.count, 2)
    }

    func testEachTurnKeepsItsOwnCounts() {
        let turns = BlockPresentation.build([
            msg("user", "q1"), cmd("a"), file("one.ts", 3, 1), msg("assistant", "a1"),
            msg("user", "q2"), cmd("b"), cmd("c"), file("two.ts", 200, 11), msg("assistant", "a2"),
        ])
        XCTAssertEqual(turns[0].meta.steps, 2)
        XCTAssertEqual(turns[0].meta.added, 3)
        XCTAssertEqual(turns[1].meta.steps, 3)
        XCTAssertEqual(turns[1].meta.added, 200)
    }

    func testAnUnansweredTurnKeepsItsOwnWork() {
        // You typed again before it replied. That work belongs to the turn it
        // happened in, not to the next one.
        let turns = BlockPresentation.build([
            msg("user", "q1"), cmd("interrupted"),
            msg("user", "q2"), cmd("second"),
        ])
        XCTAssertEqual(turns.count, 2)
        XCTAssertEqual(turns[0].work.count, 1)
        XCTAssertNil(turns[0].reply)
    }

    func testARunningTurnIsRunningAndEarlierOnesAreNot() {
        let turns = BlockPresentation.build([
            msg("user", "q1"), cmd("a"), msg("assistant", "a1"),
            msg("user", "q2"), cmd("sleep", status: "running"),
        ])
        XCTAssertEqual(turns[0].meta.status, "done")
        XCTAssertTrue(turns[1].meta.isRunning)
    }

    func testRunningBeatsFailed() {
        let turns = BlockPresentation.build([
            msg("user", "q"), cmd("boom", status: "failed"), cmd("still going", status: "running"),
        ])
        XCTAssertEqual(turns[0].meta.status, "running")
    }

    // MARK: - the summary line

    func testTheSummaryReadsAsASentenceOfCounts() {
        let turns = BlockPresentation.build([
            msg("user", "q"), cmd("a"), cmd("b"), file("x.ts", 215, 12),
        ])
        XCTAssertEqual(turns[0].meta.summary, "3 steps · 1 file +215 −12")
    }

    func testAnEmptyTurnHasNoSummaryRatherThanABlankLine() {
        let turns = BlockPresentation.build([msg("user", "just asked")])
        XCTAssertNil(turns[0].meta.summary)
    }

    func testPlanProgressComesFromTheNewestPlan() {
        let turns = BlockPresentation.build([
            msg("user", "q"),
            Block(kind: "plan", steps: [PlanStep(text: "a", status: "done"), PlanStep(text: "b", status: "todo")]),
            Block(kind: "plan", steps: [PlanStep(text: "a", status: "done"), PlanStep(text: "b", status: "done")]),
        ])
        XCTAssertEqual(turns[0].meta.planDone, 2)
        XCTAssertEqual(turns[0].meta.planTotal, 2)
    }

    func testNoPlanMeansNoPlanProgress() {
        // Codex Desktop has no plan payload at all. It must not invent one.
        let turns = BlockPresentation.build([msg("user", "q"), cmd("a")])
        XCTAssertNil(turns[0].meta.planDone)
    }

    // MARK: - sources

    func testSourcesAreCollectedFromTheTurnsWorkAndDeduplicated() {
        let a = BlockSource(title: "Pricing", domain: "posthog.com", url: "https://posthog.com/p", snippet: nil)
        let b = BlockSource(title: "Analytics", domain: "www.cnbc.com", url: "https://cnbc.com/x", snippet: nil)
        let turns = BlockPresentation.build([
            msg("user", "q"),
            Block(kind: "search", query: "one", results: [a, b]),
            Block(kind: "search", query: "two", results: [a]),
            msg("assistant", "done"),
        ])
        XCTAssertEqual(turns[0].sources.count, 2)
    }

    func testSourcesDoNotLeakBetweenTurns() {
        let a = BlockSource(title: "One", domain: "a.com", url: "https://a.com", snippet: nil)
        let turns = BlockPresentation.build([
            msg("user", "q1"), Block(kind: "search", query: "x", results: [a]), msg("assistant", "a1"),
            msg("user", "q2"), cmd("nothing"), msg("assistant", "a2"),
        ])
        XCTAssertEqual(turns[0].sources.count, 1)
        XCTAssertTrue(turns[1].sources.isEmpty)
    }

    func testAMonogramComesFromTheDomainBecauseNoLogoFieldExists() {
        let s = BlockSource(title: "t", domain: "www.posthog.com", url: "https://posthog.com", snippet: nil)
        XCTAssertEqual(s.monogram, "P")
        XCTAssertEqual(s.shortDomain, "posthog.com")
    }

    // MARK: - usage

    func testAnUnknownWindowDrawsAnEmptyMeterRatherThanAFullOne() {
        XCTAssertEqual(BlockUsage(used: 5000, window: 0).fraction, 0)
    }

    func testUsageFractionIsClamped() {
        XCTAssertEqual(BlockUsage(used: 300, window: 200).fraction, 1)
    }
}
