import Foundation
import XCTest
@testable import IPCSupport

final class JSONLineFramerTests: XCTestCase {
    func testDataSlicesEmptyReadsAndBurstOfCommands() {
        var framer = JSONLineFramer()
        var lines: [Data] = []
        framer.append(Data()) { lines.append($0) }
        // Data slices can have non-zero startIndex; raw offsets must still work.
        let slice = Data("discard\nfirst\nsecond\n".utf8).dropFirst(8)
        framer.append(slice) { lines.append($0) }
        let burst = Data(String(repeating: "next\n", count: 10000).utf8)
        framer.append(burst) { lines.append($0) }
        XCTAssertEqual(lines.count, 10002)
        XCTAssertEqual(String(decoding: lines[0], as: UTF8.self), "first")
        XCTAssertEqual(String(decoding: lines[1], as: UTF8.self), "second")
        XCTAssertTrue(lines.dropFirst(2).allSatisfy { $0 == Data("next".utf8) })
    }

    func testRealPipeDeliversLargeHistoryAndHideWithoutLosingCommands() {
        let pipe = Pipe()
        let finished = expectation(description: "history followed by cancel and hide")
        DispatchQueue.global().async {
            var framer = JSONLineFramer()
            var lengths: [Int] = []
            while true {
                let data = pipe.fileHandleForReading.availableData
                if data.isEmpty { break }
                framer.append(data) { lengths.append($0.count) }
            }
            XCTAssertEqual(lengths, [8 * 1024 * 1024, 6, 6])
            finished.fulfill()
        }
        DispatchQueue.global().async {
            let chunk = Data(repeating: 120, count: 4096)
            for _ in 0..<2048 { pipe.fileHandleForWriting.write(chunk) }
            pipe.fileHandleForWriting.write(Data("\ncancel\nhidden\n".utf8))
            try? pipe.fileHandleForWriting.close()
        }
        // Allow scheduler contention here; the isolated test below enforces
        // the strict framing budget without counting thread start latency.
        wait(for: [finished], timeout: 5)
        try? pipe.fileHandleForReading.close()
    }

    func testFragmentedUTF8AndMultipleCommandsPreserveOrder() {
        let bytes = Data("{\"text\":\"नमस्ते 👋\\nhello\"}\n\n{\"type\":\"cancel\"}\r\npartial".utf8)
        var framer = JSONLineFramer()
        var lines: [String] = []
        for byte in bytes {
            framer.append(Data([byte])) { lines.append(String(decoding: $0, as: UTF8.self)) }
        }
        XCTAssertEqual(lines, ["{\"text\":\"नमस्ते 👋\\nhello\"}", "", "{\"type\":\"cancel\"}\r"])
        framer.append(Data(" end\n".utf8)) { lines.append(String(decoding: $0, as: UTF8.self)) }
        XCTAssertEqual(lines.last, "partial end")
    }

    // Re-scanning the accumulated buffer on every pipe read makes this
    // quadratic, starving a tiny control command behind a large history.
    func testLargeFragmentedHistoryDoesNotStarveFollowingControls() {
        var framer = JSONLineFramer()
        let chunk = Data(repeating: 120, count: 4096)
        var lengths: [Int] = []
        let start = ProcessInfo.processInfo.systemUptime
        for _ in 0..<2048 { framer.append(chunk) { lengths.append($0.count) } }
        framer.append(Data("\nrecording\ncancel\nhidden\n".utf8)) { lengths.append($0.count) }
        let elapsed = ProcessInfo.processInfo.systemUptime - start
        XCTAssertEqual(lengths, [8 * 1024 * 1024, 9, 6, 6])
        XCTAssertLessThan(elapsed, 1.0, "8 MiB fragmented history must not delay controls for seconds (took \(elapsed)s)")
    }
}
