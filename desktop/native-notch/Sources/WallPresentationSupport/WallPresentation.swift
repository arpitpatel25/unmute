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

public struct WallLaunchState: Equatable {
    public let view: WallViewMode
    public let shouldEnableToday: Bool

    public init(view: WallViewMode, shouldEnableToday: Bool) {
        self.view = view
        self.shouldEnableToday = shouldEnableToday
    }
}

public enum WallLaunchPresentation {
    public static func resolve(todayOnly: Bool?) -> WallLaunchState {
        WallLaunchState(view: .today, shouldEnableToday: todayOnly != true)
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
        1
    }
}

public enum WallGroupPreview {
    public static let limit = 4

    public static func canToggle(total: Int, view: WallViewMode,
                                 workspace: WallWorkspaceSelection) -> Bool {
        view == .allWork && workspace == .all && total > limit
    }

    public static func visibleCount(total: Int, view: WallViewMode,
                                    workspace: WallWorkspaceSelection,
                                    expanded: Bool) -> Int {
        guard canToggle(total: total, view: view, workspace: workspace), !expanded else {
            return total
        }
        return min(total, limit)
    }
}
