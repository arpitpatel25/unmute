import Foundation
import Combine

public typealias ComposerStagedFile = (path: String, mime: String, name: String)

/// One process-wide ordering lane per task, shared by picker, paste and drop.
/// Work runs concurrently off-main; delivery drains strictly in reservation order.
public final class ComposerStagingStore: ObservableObject {
    public static let shared = ComposerStagingStore()
    @Published public private(set) var order = ComposerStagingOrder()
    public let maxActive: Int
    public init(maxActive: Int = 256) { self.maxActive = maxActive }

    private struct Job {
        let work: () throws -> ComposerStagedFile
        let deliver: (String, ComposerStagedFile) -> Void
        let reserved: (String) -> Void
        let failed: (String, String) -> Void
        let canceled: (String) -> Void
        var result: ComposerStagedFile?
    }
    private var jobs: [String: Job] = [:]

    public func items(task: String) -> [ComposerStagingRecord] {
        order.records.filter { $0.taskId == task && $0.phase != .removed }
    }
    public func blocksSend(task: String, attachmentIds: Set<String>) -> Bool {
        items(task: task).contains { $0.phase != .delivered || !attachmentIds.contains($0.id) }
    }

    public func reconcile(task: String, attachmentIds: Set<String>) {
        for item in items(task: task) where item.phase == .delivered && attachmentIds.contains(item.id) {
            _ = order.remove(id: item.id); order.compact(); jobs.removeValue(forKey: item.id)
        }
    }

    @discardableResult
    public func reserve(task: String, name: String, sourcePath: String?,
                 reserved: @escaping (String) -> Void = { _ in },
                 failed: @escaping (String, String) -> Void = { _, _ in },
                 canceled: @escaping (String) -> Void = { _ in },
                 work: @escaping () throws -> ComposerStagedFile,
                 deliver: @escaping (String, ComposerStagedFile) -> Void) -> String? {
        precondition(Thread.isMainThread)
        guard jobs.count < maxActive else { return nil }
        let id = UUID().uuidString
        order.reserve(.init(id: id, taskId: task, name: name, sourcePath: sourcePath))
        jobs[id] = Job(work: work, deliver: deliver, reserved: reserved, failed: failed, canceled: canceled, result: nil)
        reserved(id)
        objectWillChange.send()
        start(id)
        return id
    }

    public func remove(_ id: String) {
        jobs[id]?.canceled(id)
        if order.records.first(where: { $0.id == id })?.phase != .delivered,
           let result = jobs[id]?.result { disposeComposerHandoff(result.path) }
        let ready = order.remove(id: id)
        order.compact()
        jobs.removeValue(forKey: id)
        objectWillChange.send()
        emit(ready)
    }

    public func retry(_ id: String) {
        guard order.retry(id: id) else { return }
        jobs[id]?.reserved(id)
        objectWillChange.send(); start(id)
    }

    public func fail(task: String, id: String, error: String) {
        guard order.records.contains(where: { $0.taskId == task && $0.id == id }) else { return }
        // A native handoff can finish but backend validation/storage can still
        // reject it. Put that exact placeholder into a readable retry state.
        if let i = order.records.firstIndex(where: { $0.id == id }), order.records[i].phase == .delivered {
            var rebuilt = ComposerStagingOrder()
            for var record in order.records {
                if record.id == id { record.phase = .failed; record.error = error }
                rebuilt.reserve(record)
            }
            order = rebuilt
            objectWillChange.send()
        }
    }

    private func start(_ id: String) {
        guard let work = jobs[id]?.work else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try work() }
            DispatchQueue.main.async { [weak self] in self?.complete(id, result) }
        }
    }

    private func complete(_ id: String, _ result: Result<ComposerStagedFile, Error>) {
        guard jobs[id] != nil else {
            if case .success(let file) = result { disposeComposerHandoff(file.path) }
            return
        }
        switch result {
        case .success(let file):
            jobs[id]?.result = file
            let ready = order.complete(id: id)
            objectWillChange.send(); emit(ready)
        case .failure(let error):
            jobs[id]?.failed(id, error.localizedDescription)
            let ready = order.complete(id: id, error: error.localizedDescription)
            objectWillChange.send(); emit(ready)
        }
    }

    private func emit(_ ids: [String]) {
        for id in ids {
            guard let job = jobs[id], let result = job.result else { continue }
            job.deliver(id, result)
        }
    }
}
