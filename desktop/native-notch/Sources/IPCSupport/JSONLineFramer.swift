import Foundation
import Darwin

/// Incremental framing for the existing newline-delimited command protocol.
public struct JSONLineFramer {
    private var buffer = Data()
    public init() {}

    public mutating func append(_ chunk: Data, onLine: (Data) -> Void) {
        // Search ONLY the newly arrived bytes. Searching the accumulated
        // frame after every 4 KiB pipe read is quadratic for large histories.
        // Raw contiguous bytes also avoid Foundation Data's per-byte indexing
        // overhead. Keep the incomplete frame, never re-scan or front-shift it.
        chunk.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            guard let base = bytes.baseAddress, !bytes.isEmpty else { return }
            var start = 0
            while start < bytes.count,
                  let newline = memchr(base.advanced(by: start), 0x0A, bytes.count - start) {
                let index = base.distance(to: UnsafeRawPointer(newline))
                buffer.append(base.advanced(by: start).assumingMemoryBound(to: UInt8.self), count: index - start)
                let line = buffer
                buffer = Data()
                onLine(line)
                start = index + 1
            }
            if start < bytes.count {
                buffer.append(base.advanced(by: start).assumingMemoryBound(to: UInt8.self), count: bytes.count - start)
            }
        }
    }
}
