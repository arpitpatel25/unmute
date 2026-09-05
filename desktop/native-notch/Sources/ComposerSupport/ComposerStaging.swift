import Foundation

public enum ComposerStagingPhase: Equatable { case pending, ready, delivered, failed, removed }
public struct ComposerStagingRecord: Equatable, Identifiable {
    public let id: String; public let taskId: String; public let name: String; public let sourcePath: String?
    public var phase: ComposerStagingPhase; public var error: String?
    public init(id: String, taskId: String, name: String, sourcePath: String? = nil,
                phase: ComposerStagingPhase = .pending, error: String? = nil) {
        self.id = id; self.taskId = taskId; self.name = name; self.sourcePath = sourcePath
        self.phase = phase; self.error = error
    }
}

/// Pure ordering state. Completions may arrive in any order, but a pending
/// predecessor is a barrier. Failure/removal advances the barrier.
public struct ComposerStagingOrder {
    public private(set) var records: [ComposerStagingRecord] = []
    public init() {}
    public mutating func reserve(_ record: ComposerStagingRecord) { records.append(record) }
    public mutating func complete(id: String, error: String? = nil) -> [String] {
        guard let i = records.firstIndex(where: { $0.id == id }), records[i].phase == .pending else { return [] }
        records[i].phase = error == nil ? .ready : .failed; records[i].error = error
        return drain(task: records[i].taskId)
    }
    public mutating func remove(id: String) -> [String] {
        guard let i = records.firstIndex(where: { $0.id == id }) else { return [] }
        records[i].phase = .removed
        return drain(task: records[i].taskId)
    }
    public mutating func retry(id: String) -> Bool {
        guard let i = records.firstIndex(where: { $0.id == id }), records[i].phase == .failed,
              records[i].sourcePath != nil else { return false }
        records[i].phase = .pending; records[i].error = nil; return true
    }
    public mutating func compact(maxRecords: Int = 256) {
        records.removeAll { $0.phase == .removed }
        // Delivered means emitted, not acknowledged. Only explicit removal or
        // authoritative acknowledgment can release recoverable active content.
    }
    private mutating func drain(task: String) -> [String] {
        var output: [String] = []
        for i in records.indices where records[i].taskId == task {
            switch records[i].phase {
            case .pending: return output
            case .ready: records[i].phase = .delivered; output.append(records[i].id)
            case .delivered, .failed, .removed: continue
            }
        }
        return output
    }
}

public enum AttachmentVisualState: Equatable { case image, file, unavailableImage }
public func attachmentVisualState(isImage: Bool, fileExists: Bool, imageDecoded: Bool) -> AttachmentVisualState {
    if isImage && (!fileExists || !imageDecoded) { return .unavailableImage }
    return isImage ? .image : .file
}
