import SwiftUI
import AppKit
import UniformTypeIdentifiers
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
    /// THE CHAT VIEW. When present these win: they carry what `rows` threw away
    /// — exit codes, diffs, MCP identity, sources, reasoning, the plan. `rows`
    /// survives for tasks persisted before blocks shipped.
    var blocks: [Block] = []
    var usage: BlockUsage? = nil
    /// Whether the agent is still working. The task manager knows this for
    /// certain; the blocks often cannot say — see BlockPresentation.build.
    var running: Bool = false
    var history: ChatHistoryState? = nil
    var canEditLatestMessage: Bool = false
    var olderMessages: Int = 0
    var loadOlder: () -> Void = {}

    private var visibleBlocks: [Block] { blocks.isEmpty ? ConversationPresentation.blocks(from: rows) : blocks }

    var body: some View {
        if !visibleBlocks.isEmpty {
            BlockConversation(turns: BlockPresentation.build(visibleBlocks, running: running), id: id, usage: usage, olderMessages: olderMessages, loadOlder: loadOlder, canEditLatestMessage: canEditLatestMessage)
                // A task switch must create a fresh positioning lifecycle. This
                // prevents SwiftUI from reusing a hidden transcript while the
                // previous task's scroll state is still being reconciled.
                .id(id)
        } else {
            HStack(spacing: 8) {
                if running || history?.phase == "loading" { ProgressView().controlSize(.small) }
                Text(history?.phase == "empty" ? "No messages yet" : history?.phase == "loading" ? "Loading conversation…" : running ? "Starting…" : "Conversation history is unavailable")
            }
            .font(.system(size: 13)).foregroundColor(Theme.textFaint)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6)
        }
    }

}

// MARK: - The three units

private struct UserBubble: View {
    let text: String
    /// Theme.userBubble follows Appearance.tone, and a static computed colour
    /// changing does not invalidate a view on its own. NotchView observes this
    /// too, so this is belt-and-braces — but a bubble that silently keeps the
    /// old tone is exactly the bug that shipped once already.
    @ObservedObject private var appearance = Appearance.shared

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 4) {
                FoldableUserText(text: text)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 16).fill(Theme.userBubble))
                    .overlay(RoundedRectangle(cornerRadius: 16)
                        .stroke(Theme.userBubbleEdge, lineWidth: 0.5))
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
    var config: ChatConfigP? = nil
    var followup: FollowupP? = nil
    var composerMode: String? = nil
    var question: QuestionP? = nil
    var pastePolicy: ComposerPastePolicy = .default
    @State private var confirmUncertainRecovery = false
    @State private var text = ""
    @State private var editorHeight: CGFloat = 30
    @State private var clientRevision = 0
    @State private var agentSubmission: (revision: Int, id: String)?
    @State private var attachmentError: String? = nil
    @State private var newChatOpen = false
    @State private var editorSelection = NSRange(location: 0, length: 0)
    @ObservedObject private var staging = ComposerStagingStore.shared
    @FocusState private var focused: Bool
    /// Theme.composerFill follows Appearance.tone, and a computed colour
    /// changing does not invalidate a view on its own — the same belt-and-
    /// braces UserBubble carries, for the same reason.
    @ObservedObject private var appearance = Appearance.shared

    private var stagingItems: [ComposerStagingRecord] {
        let local = staging.items(task: taskId)
        // The helper can restart independently of Electron. Authoritative
        // reservations still have an accessible remove action after replay.
        let recovered = (draft?.operations ?? []).filter { op in !local.contains { $0.id == op.id } }
            .map { ComposerStagingRecord(id: $0.id, taskId: taskId, name: $0.name, phase: .failed,
                error: $0.error ?? "Preparation interrupted. Remove and attach again.") }
        return local + recovered
    }
    private var draftAttachmentIds: Set<String> { Set((draft?.attachments ?? []).map(\.id)) }
    private var trayIds: [String] {
        let attachments = draft?.attachments ?? [], pending = stagingItems
        let ids = attachments.map(\.id) + pending.filter { !draftAttachmentIds.contains($0.id) }.map(\.id)
        func rank(_ id: String) -> Int {
            attachments.first(where: { $0.id == id })?.reservationOrder
                ?? draft?.operations?.first(where: { $0.id == id })?.order
                ?? (Int.max - ids.count + (ids.firstIndex(of: id) ?? 0))
        }
        return ids.sorted { rank($0) < rank($1) }
    }
    private var stagingCount: Int { (draft?.stagingCount ?? 0) + stagingItems.filter { $0.phase == .pending }.count }
    private var canSend: Bool { composerFollowupCanSend(mode: composerMode) && !staging.blocksSend(task: taskId, attachmentIds: draftAttachmentIds) && (draft?.operations?.isEmpty ?? true) && (draft?.stagingCount ?? 0) == 0 && (!text.trimmingCharacters(in: .whitespaces).isEmpty || !(draft?.attachments.isEmpty ?? true)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let followup {
                VStack(alignment: .leading, spacing: 5) {
                    Text(followup.label).font(.system(size: 11.5, weight: .medium))
                    if !followup.preview.isEmpty { Text(followup.preview).font(.system(size: 11)).lineLimit(2) }
                    if !followup.attachments.isEmpty {
                        ScrollView(.horizontal, showsIndicators: true) {
                            HStack(spacing: 6) {
                                ForEach(followup.attachments, id: \.id) { attachment in
                                    ComposerAttachmentTile(attachment: attachment, remove: {}, restore: {}, readOnly: true)
                                }
                            }
                        }.frame(height: 66)
                    }
                    HStack {
                        if followup.canCancel { Button("Cancel queued delivery") { model.emit(.cancelTaskFollowup(id: taskId, queueId: followup.id)) } }
                        if followup.phase == "saved" {
                            Button("Restore to composer") { model.emit(.restoreTaskFollowup(id: taskId, queueId: followup.id)) }.disabled(!followup.canRestore)
                                .help("Send or clear your current draft before restoring. The saved follow-up is kept.")
                        }
                        if followup.canQueueAgain { Button("Queue again") { model.emit(.queueSavedTaskFollowup(id: taskId, queueId: followup.id)) } }
                        if followup.phase == "uncertain" {
                            Button("Copy back to draft…") { confirmUncertainRecovery = true }
                                .disabled(!text.isEmpty || !(draft?.attachments.isEmpty ?? true) || stagingCount > 0)
                        }
                    }.font(.system(size: 11))
                }
                .padding(8).background(Theme.sunken).clipShape(RoundedRectangle(cornerRadius: 8))
                .alert("This message may already have been sent", isPresented: $confirmUncertainRecovery) {
                    Button("Copy back — may duplicate") { model.emit(.recoverUncertainFollowup(id: taskId, queueId: followup.id)) }
                    Button("Keep saved", role: .cancel) {}
                } message: { Text("Check the conversation first. Copying restores the saved input without sending it and cannot retract a message the provider accepted.") }
            }
            if composerMode == "full" { Text("One follow-up is already saved. Your current draft is kept.").font(.system(size: 11)).foregroundColor(Theme.textDim) }
            if question == nil, model.questionSubmissions[taskId]?.state == "accepted" {
                Text("Answer accepted").font(.caption).foregroundColor(Theme.textFaint)
            }
            if stagingCount > 0 {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Preparing \(stagingCount) attachment(s)…").font(.system(size: 11.5))
                }
            }
            if let error = attachmentError ?? draft?.error {
                Text(error).font(.system(size: 11.5)).foregroundColor(Theme.cError)
            }
            if let e = deliveryError, !e.isEmpty {
                HStack(spacing: 5) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10))
                    Text(e).font(.system(size: 11.5))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .foregroundColor(Theme.cError)
            }
            VStack(alignment: .leading, spacing: 6) {
                // SHOW THE PICTURE, NOT ITS FILENAME.
                //
                // The chip led with `unmute-draft-BAD18C81-D345-484D-….png` and
                // a 22pt thumbnail beside it, so a staged image read as a row of
                // UUID rather than as the thing you captured. You cannot tell
                // WHICH screenshot is attached, or that three are, from a
                // filename — and not being able to see that is what turned "the
                // images went missing" into a night of log reading.
                //
                // So the preview IS the chip: a tile of the real image with its
                // remove control on the corner, the way every composer that
                // takes images does it. A file we cannot render still falls back
                // to a name, because then the name is all there is.
                if !(draft?.attachments.isEmpty ?? true) || !stagingItems.isEmpty {
                    ScrollView(.horizontal, showsIndicators: true) {
                    HStack(spacing: 8) {
                        ForEach(trayIds, id: \.self) { id in
                            if let attachment = draft?.attachments.first(where: { $0.id == id }) {
                                ComposerAttachmentTile(attachment: attachment,
                                    remove: { model.emit(.removeDraftAttachment(id: taskId, attachmentId: attachment.id)) },
                                    restore: { model.emit(.restoreDraftAttachment(id: taskId, attachmentId: attachment.id)) })
                            } else if let item = stagingItems.first(where: { $0.id == id }) {
                                ComposerStagingTile(item: item, retry: { staging.retry(item.id) }, remove: {
                                    if staging.items(task: taskId).contains(where: { $0.id == item.id }) { staging.remove(item.id) }
                                    else { model.emit(.removeDraftAttachment(id: taskId, attachmentId: item.id)) }
                                })
                            }
                        }
                    }
                    .padding(2)
                    }
                    .frame(height: 66)
                }
                HStack(alignment: .bottom, spacing: 8) {
                    Menu {
                        Button("Attach files and images", action: pickFiles)
                    } label: {
                        Image(systemName: "plus").frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)
                    .help("Up to 10 attachments · PNG/JPEG/GIF/WebP images 10 MB · files 25 MB · total 50 MB")
                    .accessibilityLabel("Attach files and images")
                    SubmitTextEditor(text: Binding(get: { text }, set: editText), measuredHeight: $editorHeight, taskId: taskId, pastePolicy: pastePolicy,
                                     placeholder: placeholder, onSubmit: send, onImagePaste: attachImage,
                                     onFocusChange: reportFocus,
                                     onSelectionChange: { editorSelection = $0 },
                                     onAttachmentReserved: { [taskId, clientRevision] operation, name, selection, snapshot in
                                         model.emit(.reserveDraftAttachment(id: taskId, operationId: operation, name: name,
                                             insertionOffset: selection.location, selectedLength: selection.length, clientRevision: clientRevision, insertionText: snapshot))
                                     },
                                     onAttachmentFailed: { [taskId] operation, error in model.emit(.failDraftAttachment(id: taskId, operationId: operation, error: error)) },
                                     onAttachmentCanceled: { [taskId] operation in model.emit(.removeDraftAttachment(id: taskId, attachmentId: operation)) },
                                     onAdmissionError: { attachmentError = $0 },
                                     onAttachmentUndo: { [taskId] operationId, redo in
                                         model.emit(redo ? .redoDraftAttachment(id: taskId, attachmentId: operationId) : .undoDraftAttachment(id: taskId, attachmentId: operationId))
                                     })
                        .frame(height: ComposerHeight.resolve(measured: editorHeight))
                        .focused($focused)
                    if config == nil, let m = modelLabel, !m.isEmpty {
                        Text(m).font(.system(size: 11.5)).foregroundColor(Theme.textFaint)
                    }
                    if sending {
                        // Sending is a round-trip through another app's window;
                        // silence for a second reads as "nothing happened".
                        Text(composerMode == "queue" ? "Saving follow-up…" : "Sending…").font(.system(size: 11)).foregroundColor(Theme.textFaint)
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
                    .accessibilityLabel(sending ? "Submitting message" : composerFollowupSendLabel(mode: composerMode))
                    .disabled(!canSend || sending || model.questionBusy(taskId, question))
                    .animation(Theme.hover, value: canSend)
                }
                if let config {
                    ComposerControls(config: config,
                                     change: { model.emit(.configureChat(id: taskId, field: $0, value: $1)) },
                                     dictate: { model.emit(.toggleDraftDictation(id: taskId, insertionOffset: editorSelection.location,
                                         selectedLength: editorSelection.length, clientRevision: clientRevision, insertionText: text)) },
                                     cancelDictation: { model.emit(.cancelDraftDictation(id: taskId)) },
                                     newConversation: { newChatOpen = true },
                                     newAgentConversation: taskId == "unmute-agent"
                                         ? { model.emit(.agentNewConversation) } : nil)
                }
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.composerFill))
            .overlay(RoundedRectangle(cornerRadius: 14)
                .stroke(focused ? Theme.accent.opacity(0.55) : Theme.composerEdge,
                        lineWidth: focused ? 1 : 0.75))
            .animation(Theme.hover, value: focused)
        }
        .onAppear {
            text = draft?.text ?? ""
            clientRevision = draft?.clientRevision ?? 0
            staging.reconcile(task: taskId, attachmentIds: draftAttachmentIds)
        }
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity, alignment: .center)
        .popover(isPresented: $newChatOpen) { NewConversationSetup(model: model, close: { newChatOpen = false }) }
        .onChange(of: RemoteDraftSnapshot(text: draft?.text ?? "", revision: draft?.clientRevision)) { remote in
            let next = reconcileDraft(localText: text, localRevision: clientRevision,
                                      remoteText: remote.text, remoteRevision: remote.revision)
            text = next.text
            clientRevision = next.revision
        }
        .onChange(of: taskId) { _ in
            text = draft?.text ?? ""
            clientRevision = draft?.clientRevision ?? 0
            attachmentError = nil
            editorSelection = NSRange(location: (text as NSString).length, length: 0)
            if focused { reportFocus(true) }
            staging.reconcile(task: taskId, attachmentIds: draftAttachmentIds)
        }
        .onChange(of: (draft?.attachments ?? []).map(\.id)) { ids in
            staging.reconcile(task: taskId, attachmentIds: Set(ids))
        }
    }

    private func editText(_ value: String) {
        text = value
        clientRevision += 1
        model.emit(.setDraftText(id: taskId, text: value, clientRevision: clientRevision))
    }

    private func send() {
        guard canSend && !sending else { return }
        if taskId == "unmute-agent" {
            if agentSubmission?.revision != clientRevision { agentSubmission = (clientRevision, UUID().uuidString) }
            if let submission = agentSubmission { model.emit(.agentSend(submissionId: submission.id, revision: submission.revision)) }
            return
        }
        guard model.beginQuestion(taskId, question) else { return }
        model.emit(.sendDraft(id: taskId, reference: question?.reference))
    }

    private func attachImage(_ path: String, _ mimeType: String, _ name: String, _ selection: NSRange? = nil, _ snapshot: String? = nil, _ operationId: String? = nil) {
        attachmentError = nil
        model.emit(.addDraftImage(id: taskId, path: path, mimeType: mimeType, name: name,
                                 insertionOffset: selection?.location, selectedLength: selection?.length,
                                 clientRevision: clientRevision, insertionText: snapshot, operationId: operationId ?? UUID().uuidString))
    }

    private func pickFiles() {
        let owner = NSApp.windows.first { $0 is NotchWindow && $0.isVisible } as? NotchWindow
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Attach"
        owner?.attachmentPickerOpen = true
        owner?.orderOut(nil)
        panel.begin { response in
            owner?.attachmentPickerOpen = false
            owner?.present()
            guard response == .OK else { return }
            for url in panel.urls {
                // The backend consumes the handoff file. Never give it the
                // user's original, which must survive draft removal.
                let capturedTask = taskId, selection = editorSelection, snapshot = text, revision = clientRevision
                let operation = staging.reserve(task: capturedTask, name: url.lastPathComponent, sourcePath: url.path,
                    reserved: { operation in model.emit(.reserveDraftAttachment(id: capturedTask, operationId: operation, name: url.lastPathComponent,
                        insertionOffset: selection.location, selectedLength: selection.length, clientRevision: revision, insertionText: snapshot)) },
                    failed: { operation, error in model.emit(.failDraftAttachment(id: capturedTask, operationId: operation, error: error)) },
                    canceled: { operation in model.emit(.removeDraftAttachment(id: capturedTask, attachmentId: operation)) },
                    work: { try stageComposerFile(url) },
                    deliver: { operation, staged in
                        model.emit(.addDraftImage(id: capturedTask, path: staged.path, mimeType: staged.mime, name: staged.name,
                            insertionOffset: selection.location, selectedLength: selection.length,
                            clientRevision: revision, insertionText: snapshot, operationId: operation))
                    })
                if operation == nil { attachmentError = "Too many attachments are being prepared. Remove or finish existing items first." }
            }
        }
    }

    /// Dictation delivers images by posting a synthetic ⌘V, and that keystroke
    /// did not reach this app — the text arrived and the image did not. Telling
    /// the engine which composer is focused lets it hand the image over
    /// directly instead of aiming a keystroke at us.
    private func reportFocus(_ focused: Bool) {
        model.emit(.composerFocus(id: taskId, focused: focused))
    }
}

/// AppKit supplies the key semantics SwiftUI's TextField cannot: Enter sends,
/// while Shift-Enter remains a real newline in the task draft.
private struct SubmitTextEditor: NSViewRepresentable {
    @Binding var text: String
    @Binding var measuredHeight: CGFloat
    let taskId: String
    let pastePolicy: ComposerPastePolicy
    let placeholder: String
    let onSubmit: () -> Void
    let onImagePaste: (String, String, String, NSRange?, String?, String?) -> Void
    let onFocusChange: (Bool) -> Void
    let onSelectionChange: (NSRange) -> Void
    let onAttachmentReserved: (String, String, NSRange, String) -> Void
    let onAttachmentFailed: (String, String) -> Void
    let onAttachmentCanceled: (String) -> Void
    let onAdmissionError: (String) -> Void
    let onAttachmentUndo: (String, Bool) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text, measuredHeight: $measuredHeight,
                    onSubmit: onSubmit, onImagePaste: onImagePaste, onSelectionChange: onSelectionChange)
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
        view.onFocusChange = onFocusChange
        view.stagingTaskId = taskId
        view.pastePolicy = pastePolicy
        view.onAttachmentReserved = onAttachmentReserved
        view.onAttachmentFailed = onAttachmentFailed
        view.onAttachmentCanceled = onAttachmentCanceled
        view.onAdmissionError = onAdmissionError
        view.onAttachmentUndo = onAttachmentUndo
        view.allowsUndo = true
        view.string = text
        scroll.documentView = view
        context.coordinator.measure(view)
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let view = scroll.documentView as? NSTextView else { return }
        context.coordinator.text = $text
        context.coordinator.onSubmit = onSubmit
        context.coordinator.onImagePaste = onImagePaste
        context.coordinator.onSelectionChange = onSelectionChange
        if let attachmentView = view as? AttachmentTextView {
            attachmentView.onImagePaste = onImagePaste
            attachmentView.onFocusChange = onFocusChange
            attachmentView.stagingTaskId = taskId
            attachmentView.pastePolicy = pastePolicy
            attachmentView.onAttachmentReserved = onAttachmentReserved
            attachmentView.onAttachmentFailed = onAttachmentFailed
            attachmentView.onAttachmentCanceled = onAttachmentCanceled
            attachmentView.onAdmissionError = onAdmissionError
            attachmentView.onAttachmentUndo = onAttachmentUndo
        }
        let width = max(scroll.contentSize.width, 1)
        view.textContainer?.containerSize = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        if view.string != text && !view.hasMarkedText() {
            let selection = view.selectedRange()
            view.string = text
            let length = (text as NSString).length
            view.setSelectedRange(NSRange(location: min(selection.location, length), length: min(selection.length, max(0, length - selection.location))))
        }
        context.coordinator.measure(view)
    }
    final class Coordinator: NSObject, NSTextViewDelegate {
        var text: Binding<String>
        let measuredHeight: Binding<CGFloat>
        var onSubmit: () -> Void
        var onImagePaste: (String, String, String, NSRange?, String?, String?) -> Void
        var onSelectionChange: (NSRange) -> Void
        init(text: Binding<String>, measuredHeight: Binding<CGFloat>, onSubmit: @escaping () -> Void, onImagePaste: @escaping (String, String, String, NSRange?, String?, String?) -> Void, onSelectionChange: @escaping (NSRange) -> Void) {
            self.text = text
            self.measuredHeight = measuredHeight
            self.onSubmit = onSubmit
            self.onImagePaste = onImagePaste
            self.onSelectionChange = onSelectionChange
        }
        func textViewDidChangeSelection(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            onSelectionChange(view.selectedRange())
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
            if textView.hasMarkedText() { return false }
            if NSEvent.modifierFlags.contains(.shift) { return false }
            onSubmit()
            return true
        }
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
    var config: ChatConfigP? = nil

    var body: some View {
        StageComposer(placeholder: "Reply to Codex — or hold right ⌥ and speak",
                      model: model, taskId: taskId, deliveryError: deliveryError,
                      modelLabel: modelLabel, sending: sending, draft: draft, config: config)
            // See TaskSurfaceView: @State text outlives a card switch without this.
            .id(taskId)
    }
}
