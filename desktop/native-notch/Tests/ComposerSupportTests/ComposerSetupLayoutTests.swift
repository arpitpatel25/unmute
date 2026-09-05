import XCTest
@testable import ComposerSupport

final class ComposerSetupLayoutTests: XCTestCase {
    func testClaudeConfigurationDoesNotShowUnsupportedEffort() {
        XCTAssertEqual(
            composerSetupFields(hasModels: true, hasEfforts: false, hasPermissions: true),
            [.provider, .model, .permissions, .workingFolder]
        )
    }

    func testCodexConfigurationIncludesEveryAvailableSetting() {
        XCTAssertEqual(
            composerSetupFields(hasModels: true, hasEfforts: true, hasPermissions: true),
            [.provider, .model, .effort, .permissions, .workingFolder]
        )
    }

    func testUnavailableModelAndPermissionControlsAreHidden() {
        XCTAssertEqual(
            composerSetupFields(hasModels: false, hasEfforts: false, hasPermissions: false),
            [.provider, .workingFolder]
        )
    }
}
