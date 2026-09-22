import SwiftUI
import AppKit
import ComposerSupport

/// Effective settings only: a menu selection becomes visible after the host
/// acknowledges it in the next task payload.
struct ComposerControls: View {
    let config: ChatConfigP
    let change: (String, String) -> Void
    let dictate: () -> Void
    let cancelDictation: () -> Void
    let newConversation: () -> Void
    /// Agent only. There is exactly ONE Agent conversation, so starting
    /// another ends this one — nil everywhere else, where "new conversation"
    /// means an additional chat rather than a replacement.
    var newAgentConversation: (() -> Void)?
    /// The visual tool armed for the next message, and how to change it. See
    /// ComposerToolPicker for why this is a control rather than an inference.
    var tool: ComposerTool? = nil
    var pickTool: ((ComposerTool?) -> Void)? = nil

    private var fields: [ComposerSetupField] {
        composerSetupFields(hasModels: !config.models.isEmpty,
                            hasEfforts: !config.efforts.isEmpty,
                            hasPermissions: !config.permissions.isEmpty)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(fields, id: \.self) { field in
                            setupControl(field)
                                .fixedSize(horizontal: true, vertical: false)
                        }
                    }
                }
                .frame(height: 28)

                Spacer(minLength: 8)

                // OUTSIDE THE SCROLLER, and deliberately. The provider/model
                // controls scroll horizontally when the panel is narrow; a
                // control that can scroll out of sight is one people conclude
                // does not exist. This is the feature's only entry point, so it
                // holds its place at every width.
                if let pickTool {
                    ComposerToolPicker(armed: tool, pick: pickTool)
                }


                if let state = config.dictation {
                    Button(action: dictate) {
                        Label(state == "recording" ? "Stop dictation" : state == "transcribing" ? "Transcribing…" : "Right ⌥ to dictate",
                              systemImage: state == "recording" ? "stop.circle" : "mic")
                            .foregroundColor(Theme.textFaint)
                    }
                    .buttonStyle(.plain)
                    .disabled(state == "transcribing")
                    .help(config.dictationError ?? "Press the Right Option key to dictate into this message.")
                    if state == "recording" || state == "transcribing" {
                        Button("Cancel", action: cancelDictation)
                            .buttonStyle(.plain)
                            .foregroundColor(Theme.textDim)
                            .accessibilityLabel("Cancel dictation without inserting text")
                    }
                }
            }
            .frame(minHeight: 28)
            if config.busy { Text("Settings can change after this turn finishes.").foregroundColor(Theme.textFaint) }
            if !config.mutable { Text("These settings are managed by the connected session.").foregroundColor(Theme.textFaint) }
            if let error = config.error { Text(error).foregroundColor(Theme.cError) }
            if let error = config.dictationError { Text(error).foregroundColor(Theme.cError) }
        }
        .font(Theme.fSub)
        .buttonStyle(.borderless)
    }

    @ViewBuilder
    private func setupControl(_ field: ComposerSetupField) -> some View {
        switch field {
        case .provider:
            Menu {
                Text("Changing provider starts a new conversation.")
            } label: { SetupRowLabel(label: "Provider", value: config.providerLabel) }
        case .model:
            choiceRow(label: "Model", choices: config.models, selected: config.model,
                      fallback: config.modelLabel, field: "model")
        case .effort:
            choiceRow(label: "Effort", choices: config.efforts, selected: config.effort ?? "",
                      fallback: "Effort", field: "effort")
        case .permissions:
            choiceRow(label: "Permissions", choices: config.permissions, selected: config.permission ?? "",
                      fallback: "Permissions", field: "permission")
                .help(config.permissionScope ?? "Session permissions")
        case .workingFolder:
            Menu {
                Text(config.cwd)
                Button("Show in Finder") { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: config.cwd) }
            } label: {
                SetupRowLabel(label: "Working folder", value: "Folder")
            }
            .help("\(config.cwd)\nChanging working folder starts a new conversation.")
        }
    }

    private func choiceRow(label: String, choices: [ChatChoiceP], selected: String,
                           fallback: String, field: String) -> some View {
        Menu {
            ForEach(choices, id: \.id) { item in
                Button { change(field, item.id) } label: {
                    if item.id == selected { Label(item.label, systemImage: "checkmark") }
                    else { Text(item.label) }
                }.help(item.description ?? item.label)
            }
        } label: {
            SetupRowLabel(label: label, value: choices.first(where: { $0.id == selected })?.label ?? fallback)
        }
        .disabled(config.busy || !config.mutable || choices.isEmpty)
        .accessibilityLabel("\(field): \(choices.first(where: { $0.id == selected })?.label ?? fallback)")
    }

}

private struct SetupRowLabel: View {
    let label: String
    let value: String

    var body: some View {
        HStack(spacing: 5) {
            if label == "Working folder" { Image(systemName: "folder") }
            Text(value).font(Theme.fSub).lineLimit(1).truncationMode(.middle)
                .frame(maxWidth: label == "Working folder" ? 180 : 150)
        }
        .foregroundColor(Theme.textDim)
        .padding(.horizontal, 8)
        .frame(minHeight: 28)
        .background(RoundedRectangle(cornerRadius: Theme.controlRadius).fill(Theme.raised))
        .accessibilityLabel("\(label): \(value)")
        .contentShape(Rectangle())
    }
}
