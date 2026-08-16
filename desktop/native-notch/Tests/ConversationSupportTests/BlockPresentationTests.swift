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

    // MARK: - the turn clock

    func testAStartedTurnWithNoEndIsStillRunning() {
        // The last command can finish while the model keeps thinking. Steps
        // alone would call that turn done.
        let turns = BlockPresentation.build([
            msg("user", "q"),
            Block(kind: "turnStart", startedAt: 1_786_828_333_000),
            cmd("echo done"),
        ])
        XCTAssertTrue(turns[0].meta.isRunning)
        XCTAssertEqual(turns[0].meta.startedAt, 1_786_828_333_000)
    }

    func testTheReportedWallTimeWinsOverStepTime() {
        // THE BUG: the header summed subprocess seconds and said "Worked for
        // 44s" while Codex's own window read 4m 19s. The turn reports its real
        // elapsed time; that is what the header must use.
        let turns = BlockPresentation.build([
            msg("user", "q"),
            Block(kind: "turnStart", startedAt: 1_786_828_333_000),
            Block(kind: "command", label: "Ran", command: "sleep 1", durationMs: 1000, status: "ok"),
            Block(kind: "turnEnd", durationMs: 259_000),
            msg("assistant", "done"),
        ])
        XCTAssertEqual(turns[0].meta.durationMs, 259_000)
        XCTAssertFalse(turns[0].meta.isRunning)
    }

    func testClockMarkersAreNotCountedAsSteps() {
        let turns = BlockPresentation.build([
            msg("user", "q"),
            Block(kind: "turnStart", startedAt: 1),
            cmd("a"),
            Block(kind: "turnEnd", durationMs: 10),
            msg("assistant", "r"),
        ])
        XCTAssertEqual(turns[0].meta.steps, 1)
    }

    // MARK: - runs

    func testWorkIsCutIntoRunsAtEachPieceOfNarration() {
        let runs = WorkRun.runs(of: [
            Block(kind: "reasoning", text: "First I'll look around."),
            cmd("ls"), cmd("rg foo"),
            Block(kind: "reasoning", text: "Now I'll read them."),
            Block(kind: "fileRead", path: "/a.ts"),
        ])
        XCTAssertEqual(runs.count, 2)
        XCTAssertEqual(runs[0].note, "First I'll look around.")
        XCTAssertEqual(runs[0].steps.count, 2)
        XCTAssertEqual(runs[1].steps.count, 1)
    }

    func testARunSummarisesWhatHappenedRatherThanListingIt() {
        // "exec · 200ms" twenty times is the transport, not the story.
        let run = WorkRun.runs(of: [cmd("a"), cmd("b"), Block(kind: "fileRead", path: "/x")])[0]
        XCTAssertEqual(run.summary, "read a file, ran 2 commands")
    }

    func testARunNamesTheIntegrationItUsed() {
        // NAMES, NOT COUNTS. Codex writes "Used Unmute Computer integration";
        // "Used 2 integrations" was the safe choice and it reads worse.
        let run = WorkRun.runs(of: [
            Block(kind: "mcpCall", server: "unmute-computer", tool: "click"),
            Block(kind: "mcpCall", server: "unmute-computer", tool: "type_text"),
            cmd("ls"),
        ])[0]
        XCTAssertEqual(run.summary, "Used Unmute Computer integration, ran a command")
    }

    func testTwoIntegrationsAreJoinedWithAnd() {
        let run = WorkRun.runs(of: [
            Block(kind: "mcpCall", server: "unmute-computer", tool: "click"),
            Block(kind: "mcpCall", server: "cua-computer-use", tool: "scroll"),
        ])[0]
        XCTAssertEqual(run.summary, "Used Unmute Computer and Cua Computer Use integrations")
    }

    // MARK: - naming a call

    func testACallIsTitledAsASentence() {
        // `start_session` is what the protocol calls it; "Start session" is what
        // the reader needs. The identifier moves down beside its output.
        XCTAssertEqual(WorkRun.callTitle(Block(kind: "mcpCall", server: "unmute-computer", tool: "start_session")), "Start session")
        XCTAssertEqual(WorkRun.callTitle(Block(kind: "mcpCall", server: "s", tool: "get_window_state")), "Get window state")
        XCTAssertEqual(WorkRun.callTitle(Block(kind: "mcpCall", server: "s", tool: "webArm")), "Web arm")
    }

    func testACommandKeepsTheNameItsLabellerGaveIt() {
        XCTAssertEqual(WorkRun.callTitle(Block(kind: "command", label: "Searched files", command: "rg x", status: "ok")), "Searched files")
    }

    func testAToolCallWithNoToolNameFallsBackToTheServer() {
        XCTAssertEqual(WorkRun.callTitle(Block(kind: "mcpCall", server: "chrome-devtools", tool: "")), "chrome-devtools")
    }

    func testWorkWithNoNarrationIsStillOneRun() {
        let runs = WorkRun.runs(of: [cmd("a"), cmd("b")])
        XCTAssertEqual(runs.count, 1)
        XCTAssertNil(runs[0].note)
    }

    func testClockMarkersNeverAppearAsSteps() {
        let runs = WorkRun.runs(of: [
            Block(kind: "turnStart", startedAt: 1), cmd("a"), Block(kind: "turnEnd", durationMs: 2),
        ])
        XCTAssertEqual(runs[0].steps.count, 1)
    }

    // MARK: - usage

    func testAnUnknownWindowDrawsAnEmptyMeterRatherThanAFullOne() {
        XCTAssertEqual(BlockUsage(used: 5000, window: 0).fraction, 0)
    }

    func testUsageFractionIsClamped() {
        XCTAssertEqual(BlockUsage(used: 300, window: 200).fraction, 1)
    }

    // MARK: - the task's own state settles a live turn

    func testARunningTaskMakesItsLastTurnRunning() {
        // Claude's transcript carries no turn markers, so a turn whose last
        // command had finished read as "Worked" while the agent was still
        // thinking — the header contradicting the title bar beside it.
        let turns = BlockPresentation.build([
            msg("user", "check the models"), cmd("curl …"),
        ], running: true)
        XCTAssertTrue(turns[0].meta.isRunning)
    }

    func testOnlyTheLastTurnGoesLive() {
        let turns = BlockPresentation.build([
            msg("user", "q1"), cmd("a"), msg("assistant", "a1"),
            msg("user", "q2"), cmd("b"),
        ], running: true)
        XCTAssertEqual(turns[0].meta.status, "done", "history stays history")
        XCTAssertTrue(turns[1].meta.isRunning)
    }

    func testAnAnsweredTurnIsNotReopenedByAStaleRunningFlag() {
        // The reply landed; a task-state flag that has not caught up must not
        // drag a finished turn back to "Working".
        let turns = BlockPresentation.build([
            msg("user", "q"), cmd("a"), msg("assistant", "done"),
        ], running: true)
        XCTAssertEqual(turns[0].meta.status, "done")
    }
}
