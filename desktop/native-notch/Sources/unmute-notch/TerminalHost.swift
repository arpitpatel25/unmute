import SwiftUI
import Combine
import SwiftTerm
import TerminalReplaySupport

// The live PTY terminal — SwiftTerm's emulator wrapped for SwiftUI.
//
// Data path mirrors the web cockpit's xterm:
//   in : `termData` chunks (base64) fan out via model.termBytes → feed()
//   out: keystrokes → termInput (base64) → manager.sendInput (PTY stdin)
//   size: cols/rows → termResize → manager.resize (SIGWINCH)
// AppController reconciles the one desired terminal subscription. This view
// renders bytes and emits input/size only; mount lifecycle is not authority.
struct TerminalPanel: View {
    @ObservedObject var model: NotchModel
    let taskId: String
    let tmuxAvailable: Bool

    /// THE FLOOR. This panel's height IS the PTY's size — `sizeChanged` below
    /// sends `termResize`, so anything that squeezes the panel resizes the real
    /// terminal and Claude Code redraws into whatever rows are left. A question
    /// card grew large enough to cut it to ten rows against the eighteen an
    /// `AskUserQuestion` picker needs, and the CLI started printing its own
    /// "Jump to bottom" — while that same card was telling the user to go answer
    /// down here. The surface that hands off must not starve what it hands to.
    ///
    /// 14 rows at fTerm's ~15.5pt line height, plus the header, is enough to
    /// hold a picker's tab bar, its question and its options at once.
    static let minRows = 14
    static let floorHeight: CGFloat = CGFloat(minRows) * 15.5 + 30

    /// Give the caret to the terminal itself.
    ///
    /// Walks to the mounted TerminalView rather than holding a reference: the
    /// host is an NSViewRepresentable, so the view is created and destroyed by
    /// SwiftUI and a stored one would outlive its panel.
    private func focusTerminal() {
        guard let window = NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible }),
              let terminal = Self.firstTerminalView(in: window.contentView) else { return }
        window.makeFirstResponder(terminal)
    }

    private static func firstTerminalView(in view: NSView?) -> TerminalView? {
        guard let view else { return nil }
        if let tv = view as? TerminalView { return tv }
        for child in view.subviews {
            if let found = firstTerminalView(in: child) { return found }
        }
        return nil
    }

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
                // TAKING OVER IS A CLICK, AND THE CLICK HAS TO SAY SO.
                //
                // SwiftTerm's TerminalView handles the mouse itself — scrolling,
                // drag-selection and auto-copy all worked — but a view only
                // receives KEY events as first responder, and nothing ever made
                // it one. Worse, the surface's background tap calls
                // NotchFocus.release() → makeFirstResponder(nil) whenever the
                // panel is expanded, so a click on the terminal actively left the
                // window with NO responder: every keystroke fell off the end of
                // the chain and macOS beeped. The header has said "type to take
                // over" the whole time.
                //
                // Claiming it here rather than widening the background rule keeps
                // that rule intact — a click on empty surface still gives the
                // caret back — and makes the promise literal: click the terminal,
                // it takes the keyboard.
                .onTapGesture { focusTerminal() }
        }
        .frame(maxWidth: .infinity, minHeight: Self.floorHeight, maxHeight: .infinity)
        // The terminal is CONTENT, not chrome: opaque, flat, and never glass.
        // SwiftTerm renders into an NSView that cannot meaningfully sit on a
        // translucent material anyway.
        .background(Color(red: 0.03, green: 0.035, blue: 0.043))
        .clipShape(RoundedRectangle(cornerRadius: Theme.cardRadius))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius)
            .stroke(Theme.hairline, lineWidth: 0.5))
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
        model.setTerminalMounted(taskId, true)
        return tv
    }

    func updateNSView(_ nsView: TerminalView, context: Context) {
        if context.coordinator.taskId != taskId {
            model.setTerminalMounted(context.coordinator.taskId, false)
            model.setTerminalMounted(taskId, true)
        }
        context.coordinator.taskId = taskId
    }

    static func dismantleNSView(_ nsView: TerminalView, coordinator: Coordinator) {
        coordinator.model.setTerminalMounted(coordinator.taskId, false)
        coordinator.detach()
    }

    final class Coordinator: NSObject, TerminalViewDelegate {
        let model: NotchModel
        var taskId: String
        private weak var view: TerminalView?
        private var sub: AnyCancellable?
        // Electron always sends a termData chunk in direct response to our
        // termOpen (even an empty one — see notch-controller.ts) BEFORE any
        // live output for this task can be enqueued, so the first chunk this
        // sink sees after a fresh attach is exactly the replay boundary.
        private var seenFirstChunk = false
        private let replayGate = TerminalReplayGate(schedule: { DispatchQueue.main.async(execute: $0) })

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
                if !self.seenFirstChunk {
                    self.seenFirstChunk = true
                    // `feed` parses synchronously — any reply SwiftTerm was
                    // going to auto-generate from these (possibly old,
                    // replayed) bytes has already been delivered to `send`
                    // below by the time this line runs.
                    self.replayGate.markReplayDone()
                }
            }
        }
        func detach() { sub?.cancel(); sub = nil; view = nil; replayGate.dispose() }

        // MARK: TerminalViewDelegate
        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            // Drops SwiftTerm's own auto-generated capability-query replies
            // (device attributes, window-size reports) parsed out of REPLAYED
            // history — see TerminalReplayGate. Real keystrokes typed after
            // the terminal is live are never affected.
            guard replayGate.shouldForward() else { return }
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
            if link.hasPrefix("/") || link.hasPrefix("~/") {
                IPC.emit(.openArtifact(type: "path", value: link))
            } else if let url = URL(string: link) {
                IPC.emit(.openArtifact(type: url.isFileURL ? "path" : "url",
                                       value: url.isFileURL ? url.path : url.absoluteString))
            }
        }
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
        func bell(source: TerminalView) {}
    }
}
