import Foundation

// The wire protocol between Electron main and this helper.
// Line-delimited JSON, one object per line, UTF-8. See the plan's
// "IPC protocol" section for the authoritative contract.
//
// Design notes:
//   * Commands (main → helper) are decoded with a manual `type` switch so an
//     unknown/extended command never crashes the loop — it's ignored.
//   * Events (helper → main) are a small closed set, encoded compactly.
//   * All stdout writes go through `IPC.emit` so framing (one line + flush)
//     lives in exactly one place.

// MARK: - Commands (main → helper)

// The six-rung ladder (spec 2026-07-24). One surface morphs through all of them;
// each rung is bigger than the last, growing downward + outward from the notch.
enum NotchState: String, Codable {
    case dormant    // at rest — a barely-there sliver (invisible on real-notch hw)
    case idle       // matches the notch, on hover
    case active     // calm "N running" — the agent's move, doesn't grab you
    case attention  // amber, "needs you"
    case task       // the single-task surface (~50%+ of screen)
    case cockpit    // the full wall (~80% of screen)
}

enum TaskAttentionState: String, Codable {
    case needsUser = "needs-user"
    case stuck
    case errored
    case ready
}

/// The one task currently fronted in the task surface.
struct PanelTask: Codable {
    let id: String
    let title: String
    let state: TaskAttentionState
    let summary: String?
    let options: [String]?
    let terminalHint: String?   // "open" | "collapsed"
}

// The cockpit dataset — the full wall, pushed from Electron over the same JSON
// channel so the cockpit renders NATIVELY inside this one panel (no separate
// Electron window). All strings; the helper only displays them.
struct CockpitTask: Codable {
    let id: String
    let title: String
    let subtitle: String?
    let status: String   // "running" | "blocked" | "needs-user" | "ready" | "done" | "failed"
    let path: String?
    let age: String?
}
struct CockpitData: Codable {
    let tasks: [CockpitTask]
    let queue: [String]
    let projects: [String]
    let suggestions: [String]
}

/// A decoded command. `.unknown` is a deliberate catch-all so forward-compatible
/// commands never break the read loop.
enum Command {
    case setState(state: NotchState, attention: Int, working: Int)
    case showTask(PanelTask)
    case setCockpit(CockpitData)
    case notchGeometry(hasNotch: Bool, x: Double, y: Double, w: Double, h: Double)
    case collapse
    case quit
    case unknown

    static func decode(_ line: String) -> Command {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String
        else { return .unknown }

        switch type {
        case "setState":
            let state = NotchState(rawValue: obj["state"] as? String ?? "idle") ?? .idle
            let attention = (obj["attention"] as? NSNumber)?.intValue ?? 0
            let working = (obj["working"] as? NSNumber)?.intValue ?? 0
            return .setState(state: state, attention: attention, working: working)
        case "showTask":
            guard let taskObj = obj["task"],
                  let taskData = try? JSONSerialization.data(withJSONObject: taskObj),
                  let task = try? JSONDecoder().decode(PanelTask.self, from: taskData)
            else { return .unknown }
            return .showTask(task)
        case "setCockpit":
            guard let dataObj = obj["data"],
                  let d = try? JSONSerialization.data(withJSONObject: dataObj),
                  let cockpit = try? JSONDecoder().decode(CockpitData.self, from: d)
            else { return .unknown }
            return .setCockpit(cockpit)
        case "notchGeometry":
            return .notchGeometry(
                hasNotch: obj["hasNotch"] as? Bool ?? false,
                x: (obj["x"] as? NSNumber)?.doubleValue ?? 0,
                y: (obj["y"] as? NSNumber)?.doubleValue ?? 0,
                w: (obj["w"] as? NSNumber)?.doubleValue ?? 0,
                h: (obj["h"] as? NSNumber)?.doubleValue ?? 0
            )
        case "collapse":
            return .collapse
        case "quit":
            return .quit
        default:
            return .unknown
        }
    }
}

// MARK: - Events (helper → main)

enum Event {
    case ready
    case tap
    case next
    case openDashboard
    case chooseOption(index: Int)
    case toggleTerminal(open: Bool)
    case collapsed

    var json: [String: Any] {
        switch self {
        case .ready:                    return ["type": "ready"]
        case .tap:                      return ["type": "tap"]
        case .next:                     return ["type": "next"]
        case .openDashboard:            return ["type": "openDashboard"]
        case .chooseOption(let index):  return ["type": "chooseOption", "index": index]
        case .toggleTerminal(let open): return ["type": "toggleTerminal", "open": open]
        case .collapsed:                return ["type": "collapsed"]
        }
    }
}

// MARK: - Framing

enum IPC {
    private static let stdout = FileHandle.standardOutput
    private static let lock = NSLock()

    /// Write one JSON line to stdout and flush. Thread-safe.
    static func emit(_ event: Event) {
        guard let data = try? JSONSerialization.data(withJSONObject: event.json) else { return }
        var line = data
        line.append(0x0A) // '\n'
        lock.lock()
        defer { lock.unlock() }
        stdout.write(line)
    }

    /// Read stdin line-by-line on a background thread, decoding each into a
    /// Command handed to `onCommand` (invoked on the main queue so it can touch
    /// AppKit safely).
    static func startReadLoop(onCommand: @escaping (Command) -> Void) {
        Thread.detachNewThread {
            let input = FileHandle.standardInput
            var buffer = Data()
            while true {
                let chunk = input.availableData
                if chunk.isEmpty { // EOF — parent went away; exit cleanly.
                    DispatchQueue.main.async { onCommand(.quit) }
                    return
                }
                buffer.append(chunk)
                while let nl = buffer.firstIndex(of: 0x0A) {
                    let lineData = buffer.subdata(in: buffer.startIndex..<nl)
                    buffer.removeSubrange(buffer.startIndex...nl)
                    if let line = String(data: lineData, encoding: .utf8),
                       !line.trimmingCharacters(in: .whitespaces).isEmpty {
                        let cmd = Command.decode(line)
                        DispatchQueue.main.async { onCommand(cmd) }
                    }
                }
            }
        }
    }
}
