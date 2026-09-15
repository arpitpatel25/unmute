import SwiftUI

/// THE AGENT'S PROVIDER, SAID WHERE YOU TYPE.
///
/// It lived as a bare logo in the card header, and nothing about a logo says
/// "press to change". It now sits in the composer as a named chip — provider
/// and model in words — because the composer is where the next message, the
/// thing a switch affects, is written.
///
/// Only installed providers are offered. With one installed there is nothing
/// to choose, so the chip is a plain label with no chevron; with none, it says
/// so instead of offering a switch that would fail on the next message.
struct AgentProviderSwitch: View {
    @ObservedObject var model: NotchModel
    let config: ChatConfigP

    @State private var open = false
    @State private var hovering = false
    @State private var pending: ChatChoiceP? = nil

    private var alternatives: [ChatChoiceP] { config.providers.filter { $0.id != config.provider } }
    private var switchable: Bool { !alternatives.isEmpty }
    private var selectedInstalled: Bool { config.providers.contains { $0.id == config.provider } }

    var body: some View {
        Button { if switchable { open.toggle() } } label: {
            HStack(spacing: 6) {
                ProviderMark(backend: config.provider, terminal: false, size: 11)
                // An empty list is also the moment before the first probe
                // answers, so it must not claim anything is missing.
                Text(selectedInstalled || config.providers.isEmpty
                     ? "\(config.providerLabel) · \(config.modelLabel)"
                     : "\(config.providerLabel) not installed")
                    .font(.system(size: 11.5, weight: .medium))
                    .lineLimit(1)
                if switchable {
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 8, weight: .semibold))
                }
            }
            .foregroundColor(switchable ? Theme.textDim : Theme.textFaint)
            .padding(.horizontal, 8)
            .frame(height: 22)
            .background(Capsule().fill(Color.white.opacity(switchable ? (hovering ? 0.14 : 0.07) : 0)))
            .overlay(Capsule().stroke(switchable ? Theme.hairline : Color.clear, lineWidth: 0.5))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .onHover { hovering = $0 }
        .animation(Theme.hover, value: hovering)
        .help(switchable ? "Unmute Agent is using \(config.providerLabel). Click to switch provider."
              : config.providers.isEmpty ? "Install Claude Code or Codex CLI to use the Unmute Agent."
              : "Unmute Agent is using \(config.providerLabel). Install another provider to switch.")
        .accessibilityLabel("Provider: \(config.providerLabel), \(config.modelLabel)")
        .popover(isPresented: $open, arrowEdge: .top) { menu }
        .alert("Switch to \(pending?.label ?? "provider")?", isPresented: confirming) {
            Button("Cancel", role: .cancel) { pending = nil }
            Button("Switch") {
                if let provider = pending?.id { model.emit(.agentSwitchProvider(provider: provider)) }
                pending = nil
            }
        } message: {
            if config.busy {
                Text("The current response will finish first. Then this conversation will be archived and a new one will start with a summary and your latest messages.")
            } else {
                Text("This conversation will be archived. A new conversation will start with a summary and your latest messages.")
            }
        }
    }

    private var menu: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Unmute Agent provider")
                .font(.system(size: 10.5, weight: .medium))
                .foregroundColor(Theme.textFaint)
                .padding(.horizontal, 11).padding(.top, 6).padding(.bottom, 4)
            ForEach(config.providers, id: \.id) { provider in
                Button {
                    open = false
                    if provider.id != config.provider { pending = provider }
                } label: {
                    HStack(spacing: 9) {
                        Image(systemName: "checkmark")
                            .font(.system(size: 10, weight: .semibold))
                            .opacity(provider.id == config.provider ? 1 : 0)
                        ProviderMark(backend: provider.id, terminal: false, size: 12)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(provider.label).font(.system(size: 12.5, weight: .medium))
                            if let model = provider.description {
                                Text(model).font(.system(size: 11)).foregroundColor(Theme.textDim)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 11).padding(.vertical, 7)
                    .frame(width: 210, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(HoverRowStyle())
            }
            Divider().padding(.vertical, 2)
            Text("Switching starts a new conversation with a summary of this one.")
                .font(.system(size: 10.5))
                .foregroundColor(Theme.textFaint)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 11).padding(.vertical, 6)
                .frame(width: 210, alignment: .leading)
        }
        .padding(.vertical, 4)
    }

    private var confirming: Binding<Bool> {
        Binding(get: { pending != nil }, set: { if !$0 { pending = nil } })
    }
}
