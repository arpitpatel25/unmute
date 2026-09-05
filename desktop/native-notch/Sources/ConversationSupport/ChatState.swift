import Foundation

public struct ChatQuestionReference: Codable, Equatable {
    public let requestId: String
    public let stepId: String
    public init(requestId: String, stepId: String) { self.requestId = requestId; self.stepId = stepId }
    public var payload: [String: Any] { ["requestId": requestId, "stepId": stepId] }
}
public struct ChatQuestionAcknowledgment: Codable {
    public let reference: ChatQuestionReference
    public let state: String
    public init(reference: ChatQuestionReference, state: String) { self.reference = reference; self.state = state }
}

public func mergeChatAcknowledgment(current: ChatQuestionAcknowledgment?, incoming: ChatQuestionAcknowledgment?, displayed: ChatQuestionReference?) -> ChatQuestionAcknowledgment? {
    guard let incoming else { return current }
    if let displayed { return incoming.reference == displayed ? incoming : current }
    if let current, current.reference != incoming.reference { return current }
    return incoming
}

public func canCreateChat(pending: Bool, folder: String?, hasManagedPreview: Bool) -> Bool {
    !pending && (folder.map { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? hasManagedPreview)
}

public struct ChatHistoryState: Codable {
    public let phase: String
    public let reason: String?
    public let canRetry: Bool?
}
public struct ChatMcpStatus: Codable {
    public let name: String
    public let status: String
    public let error: String?
    public let remedy: String?
}
