import XCTest
@testable import ConversationSupport

final class AttachmentBlockTests: XCTestCase {
    func testSentAttachmentRetainsMetadataAndIsNotAWorkStep() throws {
        let json = #"{"kind":"attachment","path":"/tmp/image.png","name":"Screenshot.png","mimeType":"image/png","bytes":2048}"#
        let attachment = try JSONDecoder().decode(Block.self, from: Data(json.utf8))
        XCTAssertEqual(attachment.mimeType, "image/png")
        XCTAssertEqual(attachment.bytes, 2048)
        let turns = BlockPresentation.build([Block(kind: "message", role: "user", text: "Explain this"), attachment])
        XCTAssertEqual(turns.count, 1)
        XCTAssertEqual(turns[0].meta.steps, 0)
        XCTAssertEqual(turns[0].work.first?.path, "/tmp/image.png")
    }
}
