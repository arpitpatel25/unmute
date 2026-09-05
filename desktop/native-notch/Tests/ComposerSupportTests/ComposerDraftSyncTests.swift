import XCTest
@testable import ComposerSupport

final class ComposerDraftSyncTests: XCTestCase {
    func testAcceptedAuthoritativeUpdateAdvancesWatermarkAndText() {
        let next = reconcileDraft(localText: "old", localRevision: 2, remoteText: "server", remoteRevision: 4)
        XCTAssertEqual(next, DraftSyncState(text: "server", revision: 4))
    }

    func testSameTextAuthoritativeUpdateStillAdvancesWatermark() {
        let next = reconcileDraft(localText: "same", localRevision: 2, remoteText: "same", remoteRevision: 4)
        XCTAssertEqual(next, DraftSyncState(text: "same", revision: 4))
    }

    func testOlderAuthoritativeUpdateCannotEraseNewerLocalEdit() {
        let next = reconcileDraft(localText: "typing", localRevision: 5, remoteText: "old", remoteRevision: 4)
        XCTAssertEqual(next, DraftSyncState(text: "typing", revision: 5))
    }
}
