import Foundation

public struct ConversationTurn: Equatable, Sendable {
    public let role: String
    public let text: String
    public let title: String?
    public let code: String?
    public let output: String?
    public let durationMs: Int?
    public let ok: Bool?

    public init(role: String, text: String, title: String? = nil, code: String? = nil,
                output: String? = nil, durationMs: Int? = nil, ok: Bool? = nil) {
        self.role = role; self.text = text; self.title = title; self.code = code
        self.output = output; self.durationMs = durationMs; self.ok = ok
    }
}

public struct ConversationRow: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case user, answer, work }
    public let id: String
    public let kind: Kind
    public let text: String
    public let durationMs: Int?
    public let workItems: [ConversationTurn]
}

public enum ConversationPresentation {
    public static func build(_ turns: [ConversationTurn]) -> [ConversationRow] {
        var rows: [ConversationRow] = []
        var i = 0
        while i < turns.count {
            let turn = turns[i]
            switch turn.role {
            case "user":
                rows.append(.init(id: "user-\(i)", kind: .user, text: turn.text,
                                  durationMs: nil, workItems: []))
                i += 1
            case "work":
                var items: [ConversationTurn] = []
                var j = i + 1
                while j < turns.count, turns[j].role == "tool" || turns[j].role == "commentary" {
                    items.append(turns[j]); j += 1
                }
                rows.append(.init(id: "work-\(i)", kind: .work, text: "",
                                  durationMs: turn.durationMs, workItems: items))
                i = j
            case "tool", "commentary":
                var items: [ConversationTurn] = []
                var j = i
                while j < turns.count, turns[j].role == "tool" || turns[j].role == "commentary" {
                    items.append(turns[j]); j += 1
                }
                rows.append(.init(id: "work-\(i)", kind: .work, text: "",
                                  durationMs: nil, workItems: items))
                i = j
            default:
                rows.append(.init(id: "answer-\(i)", kind: .answer, text: turn.text,
                                  durationMs: nil, workItems: []))
                i += 1
            }
        }
        return rows
    }

}

public extension Array where Element == ConversationRow {
    var markdownTexts: [String] { compactMap { $0.kind == .answer ? $0.text : nil } }
}
