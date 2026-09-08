import XCTest
@testable import WallPresentationSupport

final class WallPresentationTests: XCTestCase {
    func testWallAlwaysLaunchesInTodayAndActivatesTheEngineFilterWhenNeeded() {
        let previouslyAllWork = WallLaunchPresentation.resolve(todayOnly: false)
        XCTAssertEqual(previouslyAllWork.view, .today)
        XCTAssertTrue(previouslyAllWork.shouldEnableToday)

        let alreadyToday = WallLaunchPresentation.resolve(todayOnly: true)
        XCTAssertEqual(alreadyToday.view, .today)
        XCTAssertFalse(alreadyToday.shouldEnableToday)
    }

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

    func testUngroupedWorkspaceAlwaysComesLast() {
        XCTAssertEqual(
            WallWorkspacePresentation.orderedNames(["cloud", "", "Unmute", "AI marketing"]),
            ["cloud", "Unmute", "AI marketing", "Ungrouped"]
        )
        XCTAssertEqual(
            WallWorkspacePresentation.orderedNames(["Ungrouped", "cloud"]),
            ["cloud", "Ungrouped"]
        )
    }

    func testASelectedWorkspaceDoesNotRepeatItsNameAsAGroupHeading() {
        XCTAssertTrue(WallWorkspaceSelection.all.showsGroupHeadings)
        XCTAssertFalse(WallWorkspaceSelection.named("cloud").showsGroupHeadings)
    }

    func testOlderWorkIsAutomaticallyRevealedWheneverAnythingIsFolded() {
        XCTAssertTrue(WallDisclosure.shouldReveal(hiddenTotal: 4, showingAll: false))
        XCTAssertFalse(WallDisclosure.shouldReveal(hiddenTotal: 0, showingAll: false))
        XCTAssertFalse(WallDisclosure.shouldReveal(hiddenTotal: 4, showingAll: true))
    }

    func testOnlyTheNinetyPercentSurfaceUsesTwoCardColumns() {
        XCTAssertEqual(WallCardLayout.columnCount(surfaceFill: 0.7), 1)
        XCTAssertEqual(WallCardLayout.columnCount(surfaceFill: 0.8), 1)
        XCTAssertEqual(WallCardLayout.columnCount(surfaceFill: 0.9), 1)
    }

    func testAllWorkAcrossAllWorkspacesPreviewsFourCardsPerWorkspace() {
        XCTAssertEqual(
            WallGroupPreview.visibleCount(total: 9, view: .allWork,
                                          workspace: .all, expanded: false),
            4
        )
        XCTAssertTrue(
            WallGroupPreview.canToggle(total: 9, view: .allWork, workspace: .all)
        )
    }

    func testExpandingOneWorkspaceRevealsItsWholeAllWorkList() {
        XCTAssertEqual(
            WallGroupPreview.visibleCount(total: 9, view: .allWork,
                                          workspace: .all, expanded: true),
            9
        )
    }

    func testPreviewNeverTruncatesOtherViewsOrASelectedWorkspace() {
        XCTAssertEqual(
            WallGroupPreview.visibleCount(total: 9, view: .today,
                                          workspace: .all, expanded: false),
            9
        )
        XCTAssertEqual(
            WallGroupPreview.visibleCount(total: 9, view: .allWork,
                                          workspace: .named("cloud"), expanded: false),
            9
        )
        XCTAssertFalse(
            WallGroupPreview.canToggle(total: 4, view: .allWork, workspace: .all)
        )
    }
}
