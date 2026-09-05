import Foundation

public enum ComposerSetupField: Hashable, Sendable {
    case provider
    case model
    case effort
    case permissions
    case workingFolder
}

/// Keeps the setup panel honest about each provider's capabilities. Claude,
/// Codex, and future backends share one composer, but controls only appear when
/// the session actually supplies choices for them.
public func composerSetupFields(
    hasModels: Bool,
    hasEfforts: Bool,
    hasPermissions: Bool
) -> [ComposerSetupField] {
    var fields: [ComposerSetupField] = [.provider]
    if hasModels { fields.append(.model) }
    if hasEfforts { fields.append(.effort) }
    if hasPermissions { fields.append(.permissions) }
    fields.append(.workingFolder)
    return fields
}
