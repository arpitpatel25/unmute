import SwiftUI
import AppKit
import ConversationSupport

struct NewConversationButton: View {
    @ObservedObject var model: NotchModel
    @State private var open = false
    var body: some View {
        Button { open = true } label: { Label("New conversation", systemImage: "plus.bubble") }
            .buttonStyle(.borderless)
            .popover(isPresented: $open) { NewConversationSetup(model: model, close: { open = false }) }
    }
}

struct NewConversationSetup: View {
    @ObservedObject var model: NotchModel
    let close: () -> Void
    @State private var provider = "claude"
    @State private var folder: String? = nil
    @State private var query = ""
    @State private var submitted = false
    @State private var permission = "maximum"
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("New conversation").font(.headline)
            Picker("Provider", selection: $provider) {
                Text("Claude").tag("claude")
                Text("Codex").tag("codex")
            }.pickerStyle(.segmented)
            Picker("Permissions for this conversation", selection: $permission) {
                Text("Maximum authorized access").tag("maximum")
                Text("Ask for approval").tag("ask")
                if provider == "claude" { Text("Plan only").tag("plan") }
                else { Text("Read only").tag("read") }
            }
            TextField("Search recent projects", text: $query)
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    Button("Use isolated Unmute-managed workspace") { folder = nil }
                    ForEach((model.cockpit?.projects ?? []).filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.path.localizedCaseInsensitiveContains(query) }, id: \.path) { project in
                        Button { folder = project.path } label: {
                            VStack(alignment: .leading) {
                                Text(project.name)
                                Text(project.path).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(.borderless)
                    }
                }
            }.frame(maxHeight: 140)
            Button("Browse folder…") {
                let panel = NSOpenPanel()
                panel.canChooseFiles = false; panel.canChooseDirectories = true
                panel.canCreateDirectories = true; panel.allowsMultipleSelection = false
                panel.begin { response in if response == .OK { folder = panel.url?.path } }
            }
            Text(folder ?? model.newChatPreview?.path ?? "Resolving managed project location…")
                .font(.caption).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            if folder == nil {
                Text("Project files are retained when this conversation is removed. A colliding or expired preview will require a new preview.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let preview = model.newChatPreview {
                Text("Effective access: \(preview.permission == "workspace" ? "Workspace, without approval prompts" : preview.permission.capitalized)")
                    .font(.caption)
                if let reason = preview.permissionReason { Text(reason).font(.caption).foregroundStyle(.secondary) }
            } else if folder != nil {
                Text("Requested access: \(permission == "maximum" ? "Maximum authorized access" : permission.capitalized). Effective access is validated when the conversation is created.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let error = model.newChatError {
                Text(error).foregroundColor(Theme.cError).font(.caption)
                Button("Refresh project preview", action: refreshPreview).disabled(model.newChatPending)
            }
            HStack {
                Button("Cancel", action: close).keyboardShortcut(.cancelAction).disabled(model.newChatPending)
                Spacer()
                if model.newChatPending { ProgressView().controlSize(.small) }
                Button("Create conversation") {
                    submitted = true; model.newChatError = nil; model.newChatPending = true
                    model.emit(.newChat(provider: provider, cwd: folder, allocationId: folder == nil ? model.newChatPreview?.allocationId : nil, permission: permission))
                }.disabled(!canCreateChat(pending: model.newChatPending, folder: folder, hasManagedPreview: model.newChatPreview != nil))
            }
        }
        .padding(18).frame(width: 400)
        .onAppear { if !model.newChatPending { refreshPreview() } }
        .onChange(of: provider) { _ in permission = "maximum"; refreshPreview() }
        .onChange(of: permission) { _ in refreshPreview() }
        .onChange(of: model.newChatPending) { pending in
            if submitted && !pending && model.newChatError == nil { close() }
        }
    }
    private func refreshPreview() {
        model.newChatPreview = nil
        model.newChatError = nil
        let token = UUID().uuidString
        model.newChatPreviewToken = token
        model.emit(.previewChat(token: token, provider: provider, permission: permission))
    }
}
