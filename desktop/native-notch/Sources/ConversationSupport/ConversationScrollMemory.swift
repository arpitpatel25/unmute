import Foundation

/// Small process-local cache: collapsing/reopening reconstructs the SwiftUI
/// view, so view-local state cannot restore where each task was being read.
public final class ConversationScrollMemory {
    public static let shared = ConversationScrollMemory()
    private let limit: Int
    private var anchors: [String: String] = [:]
    private var order: [String] = []

    public init(limit: Int = 32) { self.limit = max(1, limit) }

    public func remember(task: String, anchor: String) {
        guard !task.isEmpty else { return }
        anchors[task] = anchor
        order.removeAll { $0 == task }
        order.append(task)
        while order.count > limit, let oldest = order.first {
            order.removeFirst(); anchors.removeValue(forKey: oldest)
        }
    }

    public func anchor(for task: String) -> String? { anchors[task] }
}

public struct TurnViewportFrame: Equatable {
    public let id: String
    public let minY: CGFloat
    public let maxY: CGFloat
    public init(id: String, minY: CGFloat, maxY: CGFloat) {
        self.id = id; self.minY = minY; self.maxY = maxY
    }
}

/// Choose the turn intersecting the reading edge first; otherwise the first
/// actually visible turn. Never choose content merely laid out below the view.
public func visibleTurnAnchor(frames: [TurnViewportFrame], viewportHeight: CGFloat) -> String? {
    let visible = frames.filter { $0.maxY > 0 && $0.minY < viewportHeight }
    return visible.first(where: { $0.minY <= 0 && $0.maxY > 0 })?.id
        ?? visible.min(by: { $0.minY < $1.minY })?.id
}

public struct ScrollRestoreGate {
    private var restoringTask: String?
    public init() {}
    public mutating func begin(task: String, savedAnchor: String?) -> String? {
        restoringTask = task
        return savedAnchor
    }
    public mutating func finish(task: String) {
        if restoringTask == task { restoringTask = nil }
    }
    public func mayRecord(task: String) -> Bool { restoringTask != task }
    public func mayFollow(task: String) -> Bool { restoringTask != task }
}

public final class DisclosureStateMemory {
    public static let shared = DisclosureStateMemory()
    private let limit: Int
    private var values: [String: Bool] = [:]
    private var order: [String] = []
    public init(limit: Int = 128) { self.limit = max(1, limit) }
    private func composite(_ task: String, _ key: String) -> String { "\(task)\u{1f}\(key)" }
    public func remember(task: String, key: String, open: Bool) {
        let id = composite(task, key)
        values[id] = open; order.removeAll { $0 == id }; order.append(id)
        while order.count > limit, let oldest = order.first {
            order.removeFirst(); values.removeValue(forKey: oldest)
        }
    }
    public func value(task: String, key: String) -> Bool? { values[composite(task, key)] }
}
