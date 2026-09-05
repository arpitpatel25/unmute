import SwiftUI

/// Persistent status outside the transcript, shared by both ordinary task surfaces.
struct ChatStatusView: View {
    @ObservedObject var model: NotchModel
    let task: TaskDetail
    @State private var expanded = false

    private var title: String {
        if task.activity == "Cancelling" { return "Cancelling…" }
        if task.turnOutcome == "cancelled" { return "Cancelled" }
        if let error = task.error { return error.reason }
        if let status = task.mcpStatuses?.first(where: { ["failed", "disconnected", "needs-auth"].contains($0.status) }) { return "MCP \(status.name): \(status.error ?? status.status)" }
        if let history = task.history, ["missing", "partial", "failed"].contains(history.phase) { return history.phase == "partial" ? "Conversation history is incomplete" : "Conversation history is unavailable" }
        if task.history?.phase == "loading" { return "Loading conversation…" }
        if task.status == .processing { return task.activity ?? "Working…" }
        return ""
    }
    private var details: String {
        var parts: [String] = []
        if let error = task.error { parts.append(error.reason); if let detail = error.detail { parts.append(detail) } }
        if let gap = task.mcpGap { parts.append(gap.message); parts.append(gap.fixCommand) }
        for mcp in task.mcpStatuses ?? [] {
            if ["failed", "cancelled", "disconnected", "needs-auth"].contains(mcp.status) {
                parts.append((["\(mcp.name): \(mcp.status)"] + [mcp.error, mcp.remedy].compactMap { $0 }).joined(separator: "\n"))
            }
        }
        if let reason = task.history?.reason { parts.append(reason) }
        return parts.joined(separator: "\n\n")
    }
    var body: some View {
        if !title.isEmpty || !details.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    if task.status == .processing || task.history?.phase == "loading" { ProgressView().controlSize(.mini) }
                    Text(title.isEmpty ? "Task details" : title).font(.system(size: 12)).lineLimit(2)
                        .foregroundColor(task.error == nil ? Theme.textDim : Theme.cError)
                    Spacer(minLength: 0)
                    if !details.isEmpty { Button(expanded ? "Hide details" : "Details") { expanded.toggle() }.buttonStyle(.borderless) }
                    if task.history?.canRetry == true {
                        Button("Retry history") { model.emit(.reloadHistory(id: task.id)) }.buttonStyle(.borderless)
                    }
                }
                if expanded && !details.isEmpty { OutputBox(tag: "task details", text: details).frame(maxHeight: 125) }
            }
            .padding(.top, 8)
            .onChange(of: task.id) { _ in expanded = false }
        }
    }
}
