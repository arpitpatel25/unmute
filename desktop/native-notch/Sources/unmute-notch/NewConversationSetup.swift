import SwiftUI
import AppKit
import ConversationSupport

struct NewConversationButton: View {
    @ObservedObject var model: NotchModel
    @State private var open = false
    var body: some View {
        KeyButton(label: "New conversation", symbol: "square.and.pencil") { open = true }
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
        VStack(alignment: .leading, spacing: 16) {
            Text("New conversation").font(Theme.fTitle)
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
                .textFieldStyle(.roundedBorder)
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    KeyButton(label: "Use a new workspace", symbol: "folder.badge.plus") { folder = nil }
                        .help("Use isolated Unmute-managed workspace")
                    ForEach((model.cockpit?.projects ?? []).filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.path.localizedCaseInsensitiveContains(query) }, id: \.path) { project in
                        Button { folder = project.path } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "folder").foregroundColor(Theme.textFaint)
                                Text(project.name).font(Theme.fBody).lineLimit(1)
                                Spacer()
                                if folder == project.path { Image(systemName: "checkmark").font(Theme.controlIcon) }
                            }
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: Theme.controlRadius).fill(folder == project.path ? Theme.raised : .clear))
                            .help(project.path)
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
            DisclosureGroup {
                Text(folder ?? model.newChatPreview?.path ?? "Preparing workspace…")
                    .font(Theme.fSub).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if folder == nil {
                    Text("A colliding or expired preview will require a new preview.")
                        .font(Theme.fCap).foregroundStyle(.secondary)
                }
            } label: {
                Label(folder.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "New Unmute workspace", systemImage: "folder")
                    .font(Theme.fSub).lineLimit(1).truncationMode(.middle)
            }
            if folder == nil {
                Text("Your project files stay when you remove the conversation.")
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
        .padding(24).frame(width: 420)
        .font(Theme.fSub)
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
