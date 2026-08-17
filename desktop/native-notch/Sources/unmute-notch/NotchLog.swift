import Foundation

// Verbose, human-readable logging so the LOGS ALONE describe what the user sees:
// screen + notch geometry, every state change with the exact window rectangle,
// every command in and event out. Written to a file we can tail
// (~/.unmute/remote/logs/notch.log) and mirrored to stderr (Electron captures it).
//
// Deliberately chatty — this is a build-time diagnostic surface, not production
// telemetry. It never touches the user's content, only UI geometry + events.
enum NotchLog {
    static let path: String = {
        let dir = (NSHomeDirectory() as NSString).appendingPathComponent(".unmute/remote/logs")
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return (dir as NSString).appendingPathComponent("notch.log")
    }()

    private static let queue = DispatchQueue(label: "com.unmute.notch.log")
    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()

    static func log(_ msg: String) {
        let line = "\(stamp.string(from: Date())) \(msg)\n"
        guard let data = line.data(using: .utf8) else { return }
        // BOTH WRITES GO ON THE QUEUE. The stderr write used to happen inline,
        // synchronously, on whatever thread called log() — which is usually the
        // main thread, because most of what is logged here is UI state. Measured
        // in the field at ~78 lines a second during ordinary use, that is 78
        // blocking writes a second on the thread that draws the surface, and the
        // reported symptom is the surface wedging. A log line must never be able
        // to stall the UI.
        //
        // Ordering is preserved because both writes share this one serial queue.
        let errLine = ("[notch] " + line).data(using: .utf8)
        queue.async {
            if let h = FileHandle(forWritingAtPath: path) {
                h.seekToEndOfFile(); h.write(data); try? h.close()
            } else {
                try? data.write(to: URL(fileURLWithPath: path))
            }
            if let errLine { FileHandle.standardError.write(errLine) }
        }
    }

    static func rect(_ r: NSRect) -> String {
        "x=\(Int(r.origin.x)) y=\(Int(r.origin.y)) w=\(Int(r.size.width)) h=\(Int(r.size.height))"
    }
}
