import XCTest
@testable import WallPresentationSupport

final class WallPresentationTests: XCTestCase {
    func testEachViewKeepsTheStatusesItsLabelPromises() {
        XCTAssertTrue(WallViewMode.today.includes(status: "processing"))
        XCTAssertTrue(WallViewMode.today.includes(status: "needs-user"))

        XCTAssertTrue(WallViewMode.needsYou.includes(status: "needs-user"))
        XCTAssertTrue(WallViewMode.needsYou.includes(status: "ready"))
        XCTAssertTrue(WallViewMode.needsYou.includes(status: "stuck"))
        XCTAssertTrue(WallViewMode.needsYou.includes(status: "failed"))
        XCTAssertFalse(WallViewMode.needsYou.includes(status: "processing"))
        XCTAssertFalse(WallViewMode.needsYou.includes(status: "done"))

        XCTAssertTrue(WallViewMode.finished.includes(status: "done"))
        XCTAssertFalse(WallViewMode.finished.includes(status: "ready"))

        XCTAssertTrue(WallViewMode.allWork.includes(status: "processing"))
        XCTAssertTrue(WallViewMode.allWork.includes(status: "done"))
    }

    func testWorkspaceSelectionKeepsOnlyTheChosenWorkspace() {
        XCTAssertTrue(WallWorkspaceSelection.all.includes(group: "Unmute"))
        XCTAssertTrue(WallWorkspaceSelection.named("Unmute").includes(group: "Unmute"))
        XCTAssertFalse(WallWorkspaceSelection.named("Unmute").includes(group: "cloud"))
        XCTAssertTrue(WallWorkspaceSelection.named("Ungrouped").includes(group: ""))
    }

    func testModeTitlesUseTheUserFacingVocabulary() {
        XCTAssertEqual(WallViewMode.today.title, "Today")
        XCTAssertEqual(WallViewMode.needsYou.title, "Needs you")
        XCTAssertEqual(WallViewMode.finished.title, "Finished")
        XCTAssertEqual(WallViewMode.allWork.title, "All work")
    }
}
