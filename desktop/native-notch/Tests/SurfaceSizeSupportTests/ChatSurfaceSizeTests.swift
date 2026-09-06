import XCTest
@testable import SurfaceSizeSupport

final class ChatSurfaceSizeTests: XCTestCase {
    func testDashboardUsesTheSameBoundsAsTaskChat() {
        XCTAssertEqual(ChatSurfaceSize.bound(CGSize(width: 2400, height: 1500), screen: CGSize(width: 3000, height: 2000), expanded: true), CGSize(width: 1040, height: 860))
    }
    func testChatRemainsBoundedOnLargeDisplayAndFitsSmallScreen() {
        XCTAssertEqual(ChatSurfaceSize.bound(CGSize(width: 2400, height: 1500), screen: CGSize(width: 3000, height: 2000)), CGSize(width: 1040, height: 860))
        XCTAssertEqual(ChatSurfaceSize.bound(CGSize(width: 900, height: 700), screen: CGSize(width: 800, height: 600)), CGSize(width: 776, height: 576))
    }
}
