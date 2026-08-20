public enum WallViewMode: String, CaseIterable, Equatable {
    case today
    case needsYou
    case finished
    case allWork

    public var title: String {
        switch self {
        case .today: return "Today"
        case .needsYou: return "Needs you"
        case .finished: return "Finished"
        case .allWork: return "All work"
        }
    }

    public func includes(status: String) -> Bool {
        switch self {
        case .today, .allWork:
            return true
        case .needsYou:
            return status == "needs-user" || status == "ready"
                || status == "stuck" || status == "failed"
        case .finished:
            return status == "done"
        }
    }
}

public enum WallWorkspaceSelection: Equatable {
    case all
    case named(String)

    public func includes(group: String) -> Bool {
        switch self {
        case .all:
            return true
        case .named(let selected):
            let normalized = group.isEmpty ? "Ungrouped" : group
            return selected == normalized
        }
    }
}
