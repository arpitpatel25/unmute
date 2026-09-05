import SwiftUI
import AppKit

/// Effective settings only: a menu selection becomes visible after the host
/// acknowledges it in the next task payload.
struct ComposerControls: View {
    let config: ChatConfigP
    let change: (String, String) -> Void
    let dictate: () -> Void
    let cancelDictation: () -> Void
    let newConversation: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    Menu(config.providerLabel) {
                        Text("Changing provider starts a new conversation.")
                        Button("New conversation…", action: newConversation)
                    }.foregroundColor(Theme.textDim)
                    choices(config.models, selected: config.model, fallback: config.modelLabel, field: "model")
                    if !config.efforts.isEmpty {
                        choices(config.efforts, selected: config.effort ?? "", fallback: "Effort", field: "effort")
                    }
                    if !config.permissions.isEmpty {
                        choices(config.permissions, selected: config.permission ?? "", fallback: "Permissions", field: "permission")
                            .help(config.permissionScope ?? "Session permissions")
                    }
                    Menu {
                        Text(config.cwd)
                        Button("Show in Finder") { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: config.cwd) }
                        Button("New conversation in another folder…", action: newConversation)
                    } label: {
                        Label(URL(fileURLWithPath: config.cwd).lastPathComponent, systemImage: "folder")
                            .lineLimit(1).frame(maxWidth: 160)
                    }
                    .help("\(config.cwd)\nChanging working folder starts a new conversation.")
                    if let state = config.dictation {
                        Button(action: dictate) {
                            Label(state == "recording" ? "Stop dictation" : state == "transcribing" ? "Transcribing…" : "Dictate",
                                  systemImage: state == "recording" ? "stop.circle" : "mic")
                        }
                        .disabled(state == "transcribing")
                        .help(config.dictationError ?? "Dictate into this draft using the existing capture controls.")
                        if state == "recording" || state == "transcribing" {
                            Button("Cancel dictation", action: cancelDictation)
                                .accessibilityLabel("Cancel dictation without inserting text")
                        }
                    }
                }.frame(minHeight: 28)
            }
            if config.busy { Text("Settings can change after this turn finishes.").foregroundColor(Theme.textFaint) }
            if !config.mutable { Text("These settings are managed by the connected session.").foregroundColor(Theme.textFaint) }
            if let error = config.error { Text(error).foregroundColor(Theme.cError) }
            if let error = config.dictationError { Text(error).foregroundColor(Theme.cError) }
        }
        .font(.system(size: 11.5))
        .buttonStyle(.borderless)
    }

    private func choices(_ choices: [ChatChoiceP], selected: String, fallback: String, field: String) -> some View {
        Menu {
            ForEach(choices, id: \.id) { item in
                Button { change(field, item.id) } label: {
                    if item.id == selected { Label(item.label, systemImage: "checkmark") }
                    else { Text(item.label) }
                }.help(item.description ?? item.label)
            }
        } label: {
            Text(choices.first(where: { $0.id == selected })?.label ?? fallback)
                .lineLimit(1)
        }
        .disabled(config.busy || !config.mutable || choices.isEmpty)
        .accessibilityLabel("\(field): \(choices.first(where: { $0.id == selected })?.label ?? fallback)")
    }
}
