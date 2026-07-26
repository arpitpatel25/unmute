import SwiftUI
import Combine
import SwiftTerm

// The live PTY terminal — SwiftTerm's emulator wrapped for SwiftUI.
//
// Data path mirrors the web cockpit's xterm:
//   in : `termData` chunks (base64) fan out via model.termBytes → feed()
//   out: keystrokes → termInput (base64) → manager.sendInput (PTY stdin)
//   size: cols/rows → termResize → manager.resize (SIGWINCH)
// Opening emits termOpen (main replays the buffered scrollback, then streams);
// closing emits termClose (main unsubscribes).
struct TerminalPanel: View {
    @ObservedObject var model: NotchModel
    let taskId: String
    let tmuxAvailable: Bool

    var body: some View {
        VStack(spacing: 0) {
            // A pinned header over scrolling content is exactly where the HARD
            // scroll-edge style belongs — an opaque boundary, not a soft fade,
            // because scrollback is dense and a gradient would smear it.
            HStack(spacing: 8) {
                Dot(status: .processing, size: 6, breathing: true)
                Text("Live terminal · type to take over")
                    .font(Theme.fCap).foregroundColor(Theme.textFaint)
                Spacer(minLength: 0)
                if tmuxAvailable {
                    Button(action: { model.emit(.openInTerminal(id: taskId)) }) {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.up.forward.app").font(.system(size: 10))
                            Text("Open in Terminal").font(.system(size: 11))
                        }
                        .foregroundColor(Theme.textDim)
                    }
                    .buttonStyle(.plain)
                    .help("Pop out — same tmux session, same live process")
                }
            }
            .padding(.horizontal, 11).padding(.vertical, 6)
            .background(Color.black.opacity(0.55))
            .overlay(Rectangle().fill(Theme.hairlineSoft).frame(height: 1), alignment: .bottom)

            TerminalHost(model: model, taskId: taskId)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // The terminal is CONTENT, not chrome: opaque, flat, and never glass.
        // SwiftTerm renders into an NSView that cannot meaningfully sit on a
        // translucent material anyway.
        .background(Color(red: 0.03, green: 0.035, blue: 0.043))
        .clipShape(RoundedRectangle(cornerRadius: Theme.cardRadius))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius)
            .stroke(Theme.hairline, lineWidth: 0.5))
        .onAppear { model.emit(.termOpen(id: taskId)) }
        .onDisappear { model.emit(.termClose(id: taskId)) }
    }
}

struct TerminalHost: NSViewRepresentable {
    @ObservedObject var model: NotchModel
    let taskId: String

    func makeCoordinator() -> Coordinator { Coordinator(model: model, taskId: taskId) }

    func makeNSView(context: Context) -> TerminalView {
        let tv = TerminalView(frame: .zero)
        tv.terminalDelegate = context.coordinator
        tv.nativeBackgroundColor = NSColor(calibratedRed: 0.03, green: 0.035, blue: 0.043, alpha: 1)
        tv.nativeForegroundColor = NSColor(calibratedWhite: 0.88, alpha: 1)
        tv.font = NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular)
        context.coordinator.attach(tv)
        return tv
    }

    func updateNSView(_ nsView: TerminalView, context: Context) {
        context.coordinator.taskId = taskId
    }

    static func dismantleNSView(_ nsView: TerminalView, coordinator: Coordinator) {
        coordinator.detach()
    }

    final class Coordinator: NSObject, TerminalViewDelegate {
        let model: NotchModel
        var taskId: String
        private weak var view: TerminalView?
        private var sub: AnyCancellable?

        init(model: NotchModel, taskId: String) {
            self.model = model
            self.taskId = taskId
        }

        func attach(_ tv: TerminalView) {
            view = tv
            // Feed only this task's bytes; delivery already on the main queue.
            sub = model.termBytes.sink { [weak self] (id, bytes) in
                guard let self, id == self.taskId, let v = self.view else { return }
                v.feed(byteArray: bytes[...])
            }
        }
        func detach() { sub?.cancel(); sub = nil; view = nil }

        // MARK: TerminalViewDelegate
        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            let b64 = Data(data).base64EncodedString()
            model.emit(.termInput(id: taskId, dataB64: b64))
        }
        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            guard newCols > 0, newRows > 0 else { return }
            model.emit(.termResize(id: taskId, cols: newCols, rows: newRows))
        }
        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func scrolled(source: TerminalView, position: Double) {}
        func clipboardCopy(source: TerminalView, content: Data) {
            if let s = String(data: content, encoding: .utf8) {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(s, forType: .string)
            }
        }
        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            if let url = URL(string: link) { NSWorkspace.shared.open(url) }
        }
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
        func bell(source: TerminalView) {}
    }
}
