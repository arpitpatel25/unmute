import SwiftUI
import AppKit
import ComposerSupport
import ConversationSupport

/// Scroll anchor: a zero-height marker at the end of the transcript.
private let BOTTOM = "conversation-bottom"

/// A Codex thread, rendered the way Codex renders it.
///
/// This is the GUI-agent equivalent of the live terminal: a Claude task shows a
/// raw PTY because that IS its conversation, and the honest equivalent here is
/// Codex's own item stream in Codex's own shape. The first attempt invented a
/// shape instead — labelled "you"/"codex" rows and a flat list of every tool
/// step — which looked nothing like the app it came from and buried the answer
/// under a dozen rows of plumbing.
///
/// What Codex actually does, measured from its window:
///   * your message: a right-aligned rounded bubble, never full width
///   * the whole tool run: ONE collapsed line, "Worked for 2m 46s ›", rule under
///   * the answer: left-aligned, full width, no label, no avatar, real markdown
///   * an action row under the answer (copy)
struct ConversationPanel: View {
    let rows: [ConversationRow]
    /// The task this transcript belongs to — switching tasks re-anchors.
    var id: String = ""

    var body: some View {
        if rows.isEmpty {
            Text("no messages yet")
                .font(.system(size: 13))
                .foregroundColor(Theme.textFaint)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 6)
        } else {
            // SCROLLS, rather than growing the panel. The latest exchange is
            // what you want in view on open, and a new message should follow —
            // so the scroller is anchored to the bottom and re-anchored when
            // the item count changes.
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 26) {
                        ForEach(rows) { row in
                            switch row.kind {
                            case .user:   UserBubble(text: row.text)
                            case .answer: AnswerBlock(text: row.text)
                            case .work:   WorkBlock(durationMs: row.durationMs, items: row.workItems)
                            }
                        }
                        // Anchor: scrolling to a zero-height marker puts the
                        // real last message flush with the bottom edge.
                        Color.clear.frame(height: 1).id(BOTTOM)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 2)
                }
                // ANCHOR AFTER LAYOUT, NOT DURING IT.
                //
                // `onAppear` fires before SwiftUI has laid the content out, so
                // scrolling there is a no-op — the transcript opened at the very
                // TOP every time. And `onChange(of: turns.count)` was the only
                // other trigger, which never fires when you open a conversation
                // that already has all its messages. Hopping to the next runloop
                // pass puts this after layout, where scrollTo actually lands.
                .onAppear { jump(proxy, animated: false) }
                // `id` changes when the panel switches to a different task, so
                // each task opens at its own latest message rather than
                // inheriting the previous one's scroll position.
                .onChange(of: id) { _ in jump(proxy, animated: false) }
                .onChange(of: rows.count) { _ in jump(proxy, animated: true) }
            }
        }
    }

    private func jump(_ proxy: ScrollViewProxy, animated: Bool) {
        DispatchQueue.main.async {
            if animated { withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo(BOTTOM, anchor: .bottom) } }
            else { proxy.scrollTo(BOTTOM, anchor: .bottom) }
        }
    }

}

// MARK: - The three units

private struct UserBubble: View {
    let text: String

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 4) {
                Text(text)
                    .font(.system(size: 14))
                    .foregroundColor(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 16).fill(Theme.raised))
                    .overlay(RoundedRectangle(cornerRadius: 16)
                        .stroke(Theme.hairline, lineWidth: 0.5))
            }
            // A BUBBLE HAS TO BE NARROWER THAN THE COLUMN or it stops reading as
            // one. Codex caps its own at roughly two-thirds; capping by MEASURE
            // rather than a percentage keeps that proportion honest in the
            // notch, which is far narrower than the Codex window — a literal
            // 65% there would be cramped.
            .frame(maxWidth: 460, alignment: .trailing)
        }
    }
}

private struct AnswerBlock: View {
    let text: String
    @State private var copied = false
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            RichText(text: text, size: 14)
            // Codex puts a quiet icon row under each answer. Ours carries the
            // one action we can honestly offer — rating and sharing belong to
            // Codex's account, not to a remote.
            HStack(spacing: 12) {
                Button(action: copy) {
                    HStack(spacing: 4) {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 10.5))
                        Text(copied ? "Copied" : "Copy").font(.system(size: 11.5))
                    }
                    .foregroundColor(copied ? Theme.cReady : Theme.textFaint)
                }
                .buttonStyle(.plain)
                .help("Copy this message")
            }
            .opacity(hovering || copied ? 1 : 0.35)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onHover { hovering = $0 }
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
    }
}

/// "Worked for 2m 46s ›" — everything the agent did, behind one line.
private struct WorkBlock: View {
    let durationMs: Int?
    let items: [ConversationTurn]
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: { open.toggle() }) {
                HStack(spacing: 6) {
                    Image(systemName: open ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(Theme.textFaint)
                    Text(label)
                        .font(Theme.fSub)
                        .foregroundColor(Theme.textDim)
                    Spacer(minLength: 0)
                    if !items.isEmpty {
                        NumText(text: "\(items.count) step\(items.count == 1 ? "" : "s")")
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Rectangle().fill(Theme.hairlineSoft).frame(height: 1)

            if open {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(items.enumerated()), id: \.offset) { _, it in
                        if it.role == "commentary" {
                            Text(it.text)
                                .font(.system(size: 13.5))
                                .foregroundColor(Theme.textDim)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            StepRow(turn: it)
                        }
                    }
                }
            }
        }
    }

    /// Codex phrases this as elapsed wall time; keep its wording exactly.
    private var label: String {
        guard let ms = durationMs, ms > 0 else { return "Worked on it" }
        let s = ms / 1000
        if s < 60 { return "Worked for \(s)s" }
        let m = s / 60, rem = s % 60
        return rem == 0 ? "Worked for \(m)m" : "Worked for \(m)m \(rem)s"
    }
}

/// One step inside the work block: its title, expandable to code and output.
private struct StepRow: View {
    let turn: ConversationTurn
    @State private var open = false

    private var hasBody: Bool { !(turn.code ?? "").isEmpty || !(turn.output ?? "").isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: { if hasBody { open.toggle() } }) {
                HStack(spacing: 7) {
                    Image(systemName: turn.ok == false ? "xmark" : "chevron.right")
                        .font(.system(size: 8.5, weight: .semibold))
                        .foregroundColor(turn.ok == false ? Theme.cError : Theme.textFaint)
                    Text(turn.title ?? "Step")
                        .font(Theme.fSub)
                        .foregroundColor(Theme.textDim)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let ms = turn.durationMs, ms > 0 { NumText(text: short(ms)) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if open {
                if let code = turn.code, !code.isEmpty { block(code, tint: Theme.cReady.opacity(0.85)) }
                if let out = turn.output, !out.isEmpty { block(out, tint: Theme.textDim) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func block(_ text: String, tint: Color) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(tint)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxHeight: 200)
        .padding(9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.black.opacity(0.35)))
        .padding(.leading, 14)
    }

    private func short(_ ms: Int) -> String {
        ms < 1000 ? "\(ms)ms" : String(format: "%.1fs", Double(ms) / 1000)
    }
}

/// Type into a Codex thread from unmute.
///
/// A Codex chat is never "over" — it ends when you delete it in Codex, not when
/// a turn finishes. So unlike a Claude question box this is NOT gated on
/// `needs-user`: there is always something to say. It sends through the same
/// path right-Option dictation uses, so speaking and typing land identically.
/// The composer, for any backend you can say something to.
///
/// It began as Codex's — a driven backend has no terminal, so a text field was
/// the ONLY way in. A Claude task has a terminal, which is why it never had one:
/// you could always type into the PTY. But when the stage is already open in
/// front of you, being sent into a terminal to type one line is exactly the
/// friction this surface exists to remove, so the composer is now shared.
///
/// The placeholder keeps voice primary in both cases — it names the key before
/// it names the field.
struct StageComposer: View {
    var placeholder: String = "Reply — or hold right ⌥ and speak"
    @ObservedObject var model: NotchModel
    let taskId: String
    /// Last message that did not get through — shown here, where the retry is.
    let deliveryError: String?
    /// What this thread will run on ("5.6 Terra · High"), when we know.
    var modelLabel: String? = nil
    /// True while a send is in flight.
    var sending: Bool = false
    var draft: TaskDraftP? = nil
    @State private var text = ""
    @State private var editorHeight: CGFloat = 30
    @FocusState private var focused: Bool

    private var canSend: Bool { !text.trimmingCharacters(in: .whitespaces).isEmpty || !(draft?.attachments.isEmpty ?? true) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let e = deliveryError, !e.isEmpty {
                HStack(spacing: 5) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10))
                    Text(e).font(.system(size: 11.5))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .foregroundColor(Theme.cError)
            }
            VStack(alignment: .leading, spacing: 6) {
                if let attachments = draft?.attachments, !attachments.isEmpty {
                    HStack(spacing: 7) {
                        ForEach(attachments, id: \.id) { attachment in
                            HStack(spacing: 5) {
                                if let image = NSImage(contentsOfFile: attachment.path) {
                                    Image(nsImage: image).resizable().scaledToFill().frame(width: 22, height: 22).clipShape(RoundedRectangle(cornerRadius: 4))
                                } else {
                                    Image(systemName: "photo").font(.system(size: 11))
                                }
                                Text(attachment.name).lineLimit(1).font(.system(size: 11.5))
                                Button(action: { model.emit(.removeDraftAttachment(id: taskId, attachmentId: attachment.id)) }) {
                                    Image(systemName: "xmark.circle.fill").font(.system(size: 12))
                                }.buttonStyle(.plain)
                            }
                            .padding(.horizontal, 7).padding(.vertical, 5)
                            .background(RoundedRectangle(cornerRadius: 7).fill(Theme.raised))
                        }
                    }
                }
                HStack(alignment: .bottom, spacing: 8) {
                    SubmitTextEditor(text: $text, measuredHeight: $editorHeight,
                                     placeholder: placeholder, onSubmit: send, onImagePaste: attachImage)
                        .frame(height: ComposerHeight.resolve(measured: editorHeight))
                        .focused($focused)
                    if let m = modelLabel, !m.isEmpty {
                        Text(m).font(.system(size: 11.5)).foregroundColor(Theme.textFaint)
                    }
                    if sending {
                        // Sending is a round-trip through another app's window;
                        // silence for a second reads as "nothing happened".
                        Text("Sending…").font(.system(size: 11)).foregroundColor(Theme.textFaint)
                    }
                    // The composer's ONE primary action, and the only tinted
                    // thing on this surface.
                    Button(action: send) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(canSend ? Theme.accentInk : Theme.textFaint)
                            .frame(width: 24, height: 24)
                            .background(Circle().fill(canSend ? Theme.accent : Theme.raised))
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                    .animation(Theme.hover, value: canSend)
                }
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.sunken))
            .overlay(RoundedRectangle(cornerRadius: 14)
                .stroke(focused ? Theme.accent.opacity(0.55) : Theme.hairline, lineWidth: focused ? 1 : 0.5))
            .animation(Theme.hover, value: focused)
        }
        .onAppear { text = draft?.text ?? "" }
        .onChange(of: draft?.text ?? "") { remote in
            if remote != text { text = remote }
        }
        .onChange(of: text) { value in model.emit(.setDraftText(id: taskId, text: value)) }
    }

    private func send() {
        guard canSend else { return }
        model.emit(.sendDraft(id: taskId))
    }

    private func attachImage(_ path: String, _ mimeType: String, _ name: String) {
        model.emit(.addDraftImage(id: taskId, path: path, mimeType: mimeType, name: name))
    }
}

/// AppKit supplies the key semantics SwiftUI's TextField cannot: Enter sends,
/// while Shift-Enter remains a real newline in the task draft.
private struct SubmitTextEditor: NSViewRepresentable {
    @Binding var text: String
    @Binding var measuredHeight: CGFloat
    let placeholder: String
    let onSubmit: () -> Void
    let onImagePaste: (String, String, String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text, measuredHeight: $measuredHeight,
                    onSubmit: onSubmit, onImagePaste: onImagePaste)
    }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        let view = AttachmentTextView()
        view.drawsBackground = false
        view.font = .systemFont(ofSize: 13.5)
        view.textColor = .labelColor
        view.isRichText = false
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.textContainer?.widthTracksTextView = true
        view.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.delegate = context.coordinator
        view.onImagePaste = context.coordinator.onImagePaste
        view.string = text
        scroll.documentView = view
        context.coordinator.measure(view)
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let view = scroll.documentView as? NSTextView else { return }
        let width = max(scroll.contentSize.width, 1)
        view.textContainer?.containerSize = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        if view.string != text { view.string = text }
        context.coordinator.measure(view)
    }
    final class Coordinator: NSObject, NSTextViewDelegate {
        let text: Binding<String>
        let measuredHeight: Binding<CGFloat>
        let onSubmit: () -> Void
        let onImagePaste: (String, String, String) -> Void
        init(text: Binding<String>, measuredHeight: Binding<CGFloat>, onSubmit: @escaping () -> Void, onImagePaste: @escaping (String, String, String) -> Void) {
            self.text = text
            self.measuredHeight = measuredHeight
            self.onSubmit = onSubmit
            self.onImagePaste = onImagePaste
        }
        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            text.wrappedValue = view.string
            measure(view)
        }
        func measure(_ view: NSTextView) {
            DispatchQueue.main.async {
                view.layoutManager?.ensureLayout(for: view.textContainer!)
                let height = view.layoutManager?.usedRect(for: view.textContainer!).height ?? 0
                if abs(self.measuredHeight.wrappedValue - height) > 0.5 {
                    self.measuredHeight.wrappedValue = height
                }
            }
        }
        func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            guard commandSelector == #selector(NSResponder.insertNewline(_:)) else { return false }
            if NSEvent.modifierFlags.contains(.shift) { return false }
            onSubmit()
            return true
        }
    }
}

final class AttachmentTextView: NSTextView {
    var onImagePaste: ((String, String, String) -> Void)?

    /// Stage whatever image the pasteboard is carrying. Returns false when
    /// there is none, or when it could not be written — the caller then falls
    /// back to an ordinary text paste.
    ///
    /// SEPARATE FROM `paste(_:)` ON PURPOSE. This app is `.accessory` and
    /// builds no menu, so ⌘V is delivered by AppController's key monitor via
    /// `sendAction(paste:)` rather than by AppKit's menu machinery. That walk
    /// reaches this view only when the responder chain cooperates, and when it
    /// did not the paste vanished in silence: no attachment, no text, nothing
    /// logged. Exposing the staging step lets the ⌘V path call it directly, so
    /// the composer no longer depends on a menu this app does not have.
    @discardableResult
    func stagePasteboardImage() -> Bool {
        let board = NSPasteboard.general
        let hasImage = board.canReadObject(forClasses: [NSImage.self], options: nil)
        let hasText = board.string(forType: .string) != nil
        guard composerPasteAction(hasImage: hasImage, hasText: hasText) == .stageImage else {
            NotchLog.log("composer paste: no image on the pasteboard (text=\(hasText))")
            return false
        }
        guard let image = board.readObjects(forClasses: [NSImage.self], options: nil)?.first as? NSImage,
              let data = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: data),
              let png = bitmap.representation(using: .png, properties: [:]) else {
            NotchLog.log("composer paste: pasteboard claimed an image it would not render")
            return false
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("unmute-draft-\(UUID().uuidString).png")
        do {
            try png.write(to: url)
        } catch {
            NotchLog.log("composer paste: could not write the staged image — \(error)")
            return false
        }
        NotchLog.log("composer paste: staged image \(url.lastPathComponent) (\(png.count) bytes)")
        onImagePaste?(url.path, "image/png", url.lastPathComponent)
        return true
    }

    override func paste(_ sender: Any?) {
        if stagePasteboardImage() { return }
        super.paste(sender)
    }
}


/// Codex's composer: the shared one, with Codex's own wording.
struct CodexComposer: View {
    @ObservedObject var model: NotchModel
    let taskId: String
    var deliveryError: String? = nil
    var modelLabel: String? = nil
    var sending: Bool = false
    var draft: TaskDraftP? = nil

    var body: some View {
        StageComposer(placeholder: "Reply to Codex — or hold right ⌥ and speak",
                      model: model, taskId: taskId, deliveryError: deliveryError,
                      modelLabel: modelLabel, sending: sending, draft: draft)
    }
}
