import AppKit
import SwiftUI
import SurfaceStateSupport

// THE TYPED-INPUT BOX — what the pill becomes when the user presses its
// keyboard button during an Orchestrator or Agent capture.
//
// ONE INVOCATION, NOTHING REMEMBERED. Main opens it for a single capture (the
// token is that capture's session id) and closes it from every ending the
// capture has. Nothing here persists: the next key press is a new capture, and
// a new capture always starts on the microphone.
//
// ITS OWN PANEL, because the pill must never take the keyboard — a dictation
// HUD that became key would move the caret out of the app being dictated into.
// This one has to, since it is a text field. It is a NONACTIVATING panel, so
// taking key does not activate Unmute or change the frontmost app: whatever
// the user was working in stays frontmost, which is also what keeps its
// selection, and a screenshot or a copy there, part of the same capture.
//
// THE EDITING COMMANDS ARE HANDLED HERE. This process builds no main menu, so
// ⌘V/⌘C/⌘X/⌘A/⌘Z never reach a text view by themselves (see the notch's own
// key monitor, which only serves the notch window). The text view answers them
// directly.

/// What the box shows besides the text.
final class TypedInputModel: ObservableObject {
    @Published var route: String = "agent"
    @Published var images: Int = 0
    @Published var texts: Int = 0
    @Published var isEmpty: Bool = true
}

final class TypedInputPanel: NSPanel {
    static let width: CGFloat = 560
    static let height: CGFloat = 148

    private(set) var token: String?
    private let model = TypedInputModel()
    private let textView = TypedInputTextView()
    private var host: NSHostingView<TypedInputChrome>!

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: Self.width, height: Self.height),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        // Same level as the pill it replaces: above the notch, above everything.
        level = NSWindow.Level(rawValue: SurfaceWindowPriority.pillLevel(above: NSWindow.Level.screenSaver.rawValue))
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        sharingType = .readOnly
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        hidesOnDeactivate = false
        isMovableByWindowBackground = false
        becomesKeyOnlyIfNeeded = false

        textView.onSubmit = { [weak self] in self?.submit() }
        textView.onCancel = { [weak self] in self?.cancel() }
        textView.onChange = { [weak self] text in self?.draftChanged(text) }
        textView.onPaste = { [weak self] in self?.send("typedCapturePaste") }

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.documentView = textView
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true

        host = NSHostingView(rootView: TypedInputChrome(
            model: model,
            editor: TypedInputEditor(scroll: scroll),
            onCancel: { [weak self] in self?.cancel() },
            onSubmit: { [weak self] in self?.submit() }
        ))
        contentView = host
    }

    override var canBecomeKey: Bool { token != nil }
    override var canBecomeMain: Bool { false }

    /// Open for one capture, where the pill was.
    func show(token: String, route: String, images: Int, texts: Int, geometry: NotchGeometry) {
        let fresh = self.token != token
        self.token = token
        model.route = route
        model.images = images
        model.texts = texts
        if fresh {
            // A new capture never inherits an old draft.
            textView.string = ""
            model.isEmpty = true
        }
        let pill = geometry.pillFrame()
        let frame = NSRect(x: round(pill.midX - Self.width / 2), y: pill.minY + 4,
                           width: Self.width, height: Self.height)
        setFrame(frame, display: true)
        orderFrontRegardless()
        makeKey()
        makeFirstResponder(textView)
        NotchLog.log("TYPED show token=\(token.prefix(8)) route=\(route) key=\(isKeyWindow) frame=\(NotchLog.rect(frame))")
    }

    func update(token: String, route: String, images: Int, texts: Int) {
        guard token == self.token else { return }
        model.route = route
        model.images = images
        model.texts = texts
    }

    /// Main closed the capture. Nothing is sent back — the capture is already
    /// over, and saying anything now would address a session that is gone.
    func close(token: String) {
        guard token == self.token else { return }
        dismiss()
    }

    private func dismiss() {
        token = nil
        textView.string = ""
        model.isEmpty = true
        // Ordering a key nonactivating panel out hands the keyboard straight
        // back to the app that stayed frontmost the whole time.
        orderOut(nil)
    }

    private func draftChanged(_ text: String) {
        model.isEmpty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        send("typedCaptureDraft", text: text)
    }

    private func submit() {
        guard token != nil else { return }
        let text = textView.string
        NotchLog.log("TYPED submit chars=\(text.count)")
        send("typedCaptureSubmit", text: text)
        // Gone at once, not when main's hide arrives: the box has done its job
        // the instant the words leave it. Main's hide is then a no-op.
        dismiss()
    }

    private func cancel() {
        guard token != nil else { return }
        NotchLog.log("TYPED cancel")
        send("typedCaptureCancel")
        dismiss()
    }

    private func send(_ type: String, text: String? = nil) {
        guard let token else { return }
        var obj: [String: Any] = ["type": type, "token": token]
        if let text { obj["text"] = text }
        IPC.emitRaw(obj)
    }
}

/// The text view: Return sends, ⇧Return is a new line, Escape cancels, and the
/// editing commands work without a menu.
final class TypedInputTextView: NSTextView {
    var onSubmit: () -> Void = {}
    var onCancel: () -> Void = {}
    var onChange: (String) -> Void = { _ in }
    var onPaste: () -> Void = {}

    convenience init() {
        self.init(frame: NSRect(x: 0, y: 0, width: TypedInputPanel.width - 36, height: 60))
        isRichText = false
        importsGraphics = false
        allowsUndo = true
        isAutomaticQuoteSubstitutionEnabled = false
        isAutomaticDashSubstitutionEnabled = false
        isAutomaticTextReplacementEnabled = false
        drawsBackground = false
        font = .systemFont(ofSize: 15)
        textColor = .white
        insertionPointColor = .white
        textContainerInset = NSSize(width: 0, height: 4)
    }

    override func keyDown(with event: NSEvent) {
        let mods = event.modifierFlags.intersection([.shift, .option, .control, .command])
        switch event.keyCode {
        // Return / Enter sends — unless an input method is composing, where
        // Return means "commit these characters", not "send".
        case 36 where mods.isEmpty && !hasMarkedText(),
             76 where mods.isEmpty && !hasMarkedText():
            onSubmit()
        case 53:                          // Escape
            onCancel()
        default:
            super.keyDown(with: event)
        }
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard window?.firstResponder === self,
              event.modifierFlags.contains(.command), !event.modifierFlags.contains(.control),
              let ch = event.charactersIgnoringModifiers?.lowercased() else {
            return super.performKeyEquivalent(with: event)
        }
        let shift = event.modifierFlags.contains(.shift)
        switch ch {
        case "v" where !shift: paste(nil); return true
        case "c": copy(nil); return true
        case "x": cut(nil); return true
        case "a": selectAll(nil); return true
        case "z":
            if shift { undoManager?.redo() } else { undoManager?.undo() }
            return true
        case "\r":                         // ⌘Return also sends
            onSubmit(); return true
        default:
            return super.performKeyEquivalent(with: event)
        }
    }

    /// Text is pasted as plain text. An image cannot live in this field, so it
    /// is handed to main, which adds it to the capture beside the text.
    override func paste(_ sender: Any?) {
        let board = NSPasteboard.general
        if board.string(forType: .string) != nil { pasteAsPlainText(sender) }
        onPaste()
    }

    override func didChangeText() {
        super.didChangeText()
        onChange(string)
    }
}

/// Hosts the AppKit scroll view inside the SwiftUI chrome.
struct TypedInputEditor: NSViewRepresentable {
    let scroll: NSScrollView
    func makeNSView(context: Context) -> NSScrollView { scroll }
    func updateNSView(_ nsView: NSScrollView, context: Context) {}
}

struct TypedInputChrome: View {
    @ObservedObject var model: TypedInputModel
    let editor: TypedInputEditor
    let onCancel: () -> Void
    let onSubmit: () -> Void

    private var placeholder: String {
        model.route == "task" ? "Type what you want done…" : "Type to the Unmute Agent…"
    }

    private var captured: String? {
        var parts: [String] = []
        if model.images > 0 { parts.append(model.images == 1 ? "1 image" : "\(model.images) images") }
        if model.texts > 0 { parts.append(model.texts == 1 ? "1 copied item" : "\(model.texts) copied items") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ") + " attached"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .topLeading) {
                if model.isEmpty {
                    Text(placeholder)
                        .font(.system(size: 15))
                        .foregroundColor(Theme.textFaint)
                        .padding(.top, 4)
                        .allowsHitTesting(false)
                }
                editor
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            HStack(spacing: 10) {
                if let captured {
                    Label(captured, systemImage: "paperclip")
                        .font(.system(size: 12))
                        .foregroundColor(Theme.textDim)
                        .lineLimit(1)
                } else {
                    Text("Return to send · ⇧Return new line · Esc to cancel")
                        .font(.system(size: 12))
                        .foregroundColor(Theme.textFaint)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                TypedInputButton(symbol: "xmark", help: "Cancel", action: onCancel)
                TypedInputButton(symbol: "arrow.up", prominent: true, help: "Send", action: onSubmit)
                    .opacity(model.isEmpty && captured == nil ? 0.45 : 1)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color.black.opacity(0.92))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(model.route == "task" ? AnyShapeStyle(Color.white.opacity(0.14)) : AnyShapeStyle(Theme.agentRim),
                              lineWidth: 1)
        )
    }
}

private struct TypedInputButton: View {
    let symbol: String
    var prominent: Bool = false
    let help: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .bold))
                .foregroundColor(prominent ? Color.black.opacity(0.88) : Color.white.opacity(hovering ? 1 : 0.88))
                .frame(width: 26, height: 26)
                .background(Circle().fill(prominent
                    ? Color.white.opacity(hovering ? 1 : 0.90)
                    : Color.white.opacity(hovering ? 0.28 : 0.15)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(help)
    }
}
