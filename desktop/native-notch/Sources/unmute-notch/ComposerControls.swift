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
    @State private var setupPinned = false
    @State private var setupHovered = false
    @State private var hoverToken = UUID()

    private var fields: [ComposerSetupField] {
        composerSetupFields(hasModels: !config.models.isEmpty,
                            hasEfforts: !config.efforts.isEmpty,
                            hasPermissions: !config.permissions.isEmpty)
    }

    private var setupVisible: Bool { setupPinned || setupHovered }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Button {
                    setupPinned.toggle()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "command")
                        Text("Task setup")
                        Image(systemName: setupVisible ? "chevron.up" : "chevron.down")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundColor(Theme.textFaint)
                    }
                    .foregroundColor(Theme.textDim)
                    .padding(.horizontal, 9).padding(.vertical, 5)
                    .background(RoundedRectangle(cornerRadius: 7).fill(setupVisible ? Theme.raisedHover : Theme.raised))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(setupVisible ? "Close task setup" : "Open task setup")
                .onHover(perform: updateSetupHover)
                .popover(isPresented: setupPresentation, arrowEdge: .bottom) {
                    setupPanel.onHover(perform: updateSetupHover)
                }

                Spacer(minLength: 8)

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
        .font(.system(size: 11.5))
        .buttonStyle(.borderless)
        .animation(Theme.hover, value: setupVisible)
    }

    private var setupPresentation: Binding<Bool> {
        Binding(get: { setupVisible }, set: { shown in
            if !shown { setupPinned = false; setupHovered = false }
        })
    }

    private var setupPanel: some View {
        VStack(spacing: 2) {
            ForEach(fields, id: \.self) { field in
                setupControl(field)
            }
        }
        .padding(7)
        .frame(width: 300)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.plane))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.composerEdge, lineWidth: 0.75))
        .shadow(color: Color.black.opacity(0.5), radius: 16, y: 7)
    }

    @ViewBuilder
    private func setupControl(_ field: ComposerSetupField) -> some View {
        switch field {
        case .provider:
            Menu {
                Text("Changing provider starts a new conversation.")
                Button("New conversation…", action: newConversation)
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
                Button("New conversation in another folder…", action: newConversation)
            } label: {
                SetupRowLabel(label: "Working folder", value: URL(fileURLWithPath: config.cwd).lastPathComponent)
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

    private func updateSetupHover(_ inside: Bool) {
        let token = UUID()
        hoverToken = token
        if inside {
            setupHovered = true
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
                guard hoverToken == token else { return }
                setupHovered = false
            }
        }
    }
}

private struct SetupRowLabel: View {
    let label: String
    let value: String

    var body: some View {
        HStack(spacing: 10) {
            Text(label).foregroundColor(Theme.textDim)
            Spacer(minLength: 12)
            Text(value).foregroundColor(Theme.text).lineLimit(1)
            Image(systemName: "chevron.right")
                .font(.system(size: 8, weight: .semibold))
                .foregroundColor(Theme.textFaint)
        }
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, minHeight: 38)
        .contentShape(Rectangle())
    }
}
