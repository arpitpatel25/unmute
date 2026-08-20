public enum StageBodyMode: Equatable {
    case messages
    case relaunching
    case terminal
}

public enum StageLayoutAction: Equatable {
    case focusTask
    case toggle
    case close
}

/// The Orchestrator wall is for choosing work; once chosen, the task is the
/// whole surface. Split remains an explicit view the user can ask for.
public func stageFullState(current: Bool, action: StageLayoutAction) -> Bool {
    switch action {
    case .focusTask: return true
    case .toggle: return !current
    case .close: return false
    }
}

public func stageBodyMode(hasTerminal: Bool, terminalRequested: Bool,
                          alive: Bool, resuming: Bool) -> StageBodyMode {
    guard hasTerminal, terminalRequested else { return .messages }
    if alive { return .terminal }
    if resuming { return .relaunching }
    return .messages
}
