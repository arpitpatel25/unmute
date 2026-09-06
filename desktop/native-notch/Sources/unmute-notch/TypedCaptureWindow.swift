import AppKit
import SwiftUI

/// Separate key-capable panel: the ordinary dictation HUD never takes focus.
final class TypedCaptureWindow: NSPanel {
    private var token = ""
    private let draft = TypedCaptureDraft()
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 560, height: 148),
                   styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        level = .screenSaver
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        hidesOnDeactivate = false
        hasShadow = true
        contentView = NSHostingView(rootView: TypedCaptureView(draft: draft,
            submit: { [weak self] in self?.submit() },
            cancel: { [weak self] in self?.send("typedCaptureCancel") },
            voice: { [weak self] in self?.send("typedCaptureVoice") }))
    }

    func show(token: String) {
        guard self.token != token || !isVisible else { return }
        self.token = token
        draft.text = ""
        if let screen = NSScreen.main {
            setFrameOrigin(NSPoint(x: screen.visibleFrame.midX - 280, y: screen.visibleFrame.minY + 60))
        }
        makeKeyAndOrderFront(nil)
    }

    func submit() { send("typedCaptureSubmit", text: draft.text) }

    private func send(_ type: String, text: String? = nil) {
        var payload: [String: Any] = ["type": type, "token": token]
        if let text { payload["text"] = text }
        IPC.emitRaw(payload)
    }
}

private final class TypedCaptureDraft: ObservableObject {
    @Published var text = ""
}

private struct TypedCaptureView: View {
    @ObservedObject var draft: TypedCaptureDraft
    let submit: () -> Void
    let cancel: () -> Void
    let voice: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            TextField("Type your request…", text: $draft.text)
                .textFieldStyle(.plain)
                .font(.system(size: 16))
                .focused($focused)
                .onSubmit(submit)
            HStack {
                Button(action: voice) { Label("Use microphone", systemImage: "mic") }
                Spacer()
                Text("Enter or shortcut to send").font(.caption).foregroundStyle(.secondary)
                Button("Cancel", action: cancel)
                Button(action: submit) { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                    .accessibilityLabel("Send request")
            }
            .buttonStyle(.plain)
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(white: 0.08), in: RoundedRectangle(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.white.opacity(0.18)))
        .preferredColorScheme(.dark)
        .onAppear { focused = true }
        .onExitCommand(perform: cancel)
    }
}
