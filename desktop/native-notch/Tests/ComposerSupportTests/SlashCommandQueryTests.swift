import XCTest
@testable import ComposerSupport

private struct Cmd: SlashCommandItem, Equatable {
    var name: String
    var title: String = ""
    var description: String = ""
    var scope: String = "Personal"
    var token: String = ""
}

final class SlashCommandQueryTests: XCTestCase {
    private let commands = [
        Cmd(name: "frontend-design", title: "Frontend Design", description: "Guidance for distinctive visual design", token: "/frontend-design"),
        Cmd(name: "review", title: "Code Review", description: "Review the current diff", token: "/review"),
        Cmd(name: "front-matter", title: "", description: "Edit the header", token: "/front-matter"),
        Cmd(name: "commit", title: "", description: "Stage and commit the frontend work", token: "/commit"),
    ]

    func testBareSlashOpensTheMenuWithAnEmptyQuery() {
        XCTAssertEqual(SlashCommands.query(for: "/"), "")
    }

    func testPartialAndFullCommandsAreQueries() {
        XCTAssertEqual(SlashCommands.query(for: "/fr"), "fr")
        XCTAssertEqual(SlashCommands.query(for: "/frontend-design"), "frontend-design")
        XCTAssertEqual(SlashCommands.query(for: "/octo:auto"), "octo:auto")
    }

    func testProseWithASlashIsNotACommand() {
        XCTAssertNil(SlashCommands.query(for: "hello /x"))
        XCTAssertNil(SlashCommands.query(for: "/fr more"))
        XCTAssertNil(SlashCommands.query(for: ""))
        XCTAssertNil(SlashCommands.query(for: " /fr"))
        XCTAssertNil(SlashCommands.query(for: "/fr\n"))
    }

    func testAcceptedTokenClosesTheMenuItCameFrom() {
        // The trailing space is what makes the draft prose again, so the menu
        // cannot re-open over the prompt being typed after the command.
        XCTAssertNil(SlashCommands.query(for: SlashCommands.accepted(token: "/frontend-design")))
        XCTAssertNil(SlashCommands.query(for: SlashCommands.accepted(token: "$frontend-design")))
    }

    func testEmptyQueryListsEverything() {
        XCTAssertEqual(SlashCommands.filter(commands, query: "").map(\.name),
                       ["frontend-design", "review", "front-matter", "commit"])
    }

    func testNamePrefixOutranksNameSubstringOutranksProse() {
        XCTAssertEqual(SlashCommands.filter(commands, query: "front").map(\.name),
                       ["frontend-design", "front-matter", "commit"])
    }

    func testMatchingIsCaseInsensitive() {
        XCTAssertEqual(SlashCommands.filter(commands, query: "REV").map(\.name), ["review"])
        XCTAssertEqual(SlashCommands.filter(commands, query: "code rev").map(\.name), ["review"])
    }

    func testNoMatchIsAnEmptyList() {
        XCTAssertTrue(SlashCommands.filter(commands, query: "zzz").isEmpty)
    }

    func testTheListIsCapped() {
        let many = (0..<120).map { Cmd(name: "cmd\($0)", token: "/cmd\($0)") }
        XCTAssertEqual(SlashCommands.filter(many, query: "cmd").count, SlashCommands.listLimit)
        XCTAssertEqual(SlashCommands.filter(many, query: "").count, SlashCommands.listLimit)
    }

    func testSelectionWraps() {
        XCTAssertEqual(SlashCommands.move(selection: 0, count: 3, delta: 1), 1)
        XCTAssertEqual(SlashCommands.move(selection: 2, count: 3, delta: 1), 0)
        XCTAssertEqual(SlashCommands.move(selection: 0, count: 3, delta: -1), 2)
    }

    func testSelectionSurvivesAnEmptyOrShrunkList() {
        XCTAssertEqual(SlashCommands.move(selection: 0, count: 0, delta: 1), 0)
        XCTAssertEqual(SlashCommands.clamp(selection: 7, count: 3), 2)
        XCTAssertEqual(SlashCommands.clamp(selection: 7, count: 0), 0)
        XCTAssertEqual(SlashCommands.clamp(selection: 1, count: 3), 1)
    }

    func testAcceptedInsertsTheTokenVerbatim() {
        // Codex's token is NOT "/name", and re-deriving it from the name is the
        // exact bug this asserts against.
        XCTAssertEqual(SlashCommands.accepted(token: "$frontend-design"), "$frontend-design ")
        XCTAssertEqual(SlashCommands.accepted(token: "/frontend-design"), "/frontend-design ")
    }
}
