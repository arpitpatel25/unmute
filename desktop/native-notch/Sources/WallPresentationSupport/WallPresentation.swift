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

    public var showsGroupHeadings: Bool {
        self == .all
    }
}

public enum WallWorkspacePresentation {
    public static func orderedNames(_ names: [String]) -> [String] {
        let normalized = names.map { $0.isEmpty ? "Ungrouped" : $0 }
        return normalized.filter { $0 != "Ungrouped" }
            + normalized.filter { $0 == "Ungrouped" }
    }
}

public enum WallDisclosure {
    public static func shouldReveal(hiddenTotal: Int?, showingAll: Bool?) -> Bool {
        (hiddenTotal ?? 0) > 0 && showingAll != true
    }
}

public enum WallCardLayout {
    public static func columnCount(surfaceFill: Double) -> Int {
        surfaceFill >= 0.895 ? 2 : 1
    }
}
