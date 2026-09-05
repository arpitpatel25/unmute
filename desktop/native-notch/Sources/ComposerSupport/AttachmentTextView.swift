import AppKit

open class AttachmentTextView: NSTextView {
    public var onImagePaste: ((String, String, String, NSRange?, String?, String?) -> Void)?
    public var onAttachmentUndo: ((String, Bool) -> Void)?
    public var onAttachmentReserved: ((String, String, NSRange, String) -> Void)?
    public var onAttachmentFailed: ((String, String) -> Void)?
    public var onAttachmentCanceled: ((String) -> Void)?
    public var onAdmissionError: ((String) -> Void)?
    public var pastePolicy = ComposerPastePolicy.default
    public var composerPasteboard = NSPasteboard.general
    private var editorGeneration = 0
    public var stagingTaskId = "" {
        didSet {
            if stagingTaskId != oldValue { editorGeneration += 1; undoManager?.removeAllActions(withTarget: self) }
        }
    }

    private func stageAsync(name: String, sourcePath: String? = nil,
                            _ work: @escaping () throws -> (path: String, mime: String, name: String)) {
        let completion = onImagePaste
        let selection = selectedRange()
        let snapshot = string
        let undo = onAttachmentUndo
        let task = stagingTaskId
        let generation = editorGeneration
        let reserved = onAttachmentReserved, failed = onAttachmentFailed, canceled = onAttachmentCanceled
        let operation = ComposerStagingStore.shared.reserve(task: task, name: name, sourcePath: sourcePath,
            reserved: { reserved?($0, name, selection, snapshot) },
            failed: { failed?($0, $1) }, canceled: { canceled?($0) }, work: work) { [weak self] orderedOperation, staged in
            completion?(staged.path, staged.mime, staged.name, selection, snapshot, orderedOperation)
            if let self, self.editorGeneration == generation, self.stagingTaskId == task, let undo {
                self.registerAttachmentUndo(orderedOperation, redo: false, generation: generation, callback: undo)
            }
        }
        if operation == nil { onAdmissionError?("Too many attachments are being prepared. Remove or finish existing items first.") }
    }

    private func registerAttachmentUndo(_ operation: String, redo: Bool, generation: Int, callback: @escaping (String, Bool) -> Void) {
        undoManager?.registerUndo(withTarget: self) { target in
            guard target.editorGeneration == generation else { return }
            callback(operation, redo)
            target.registerAttachmentUndo(operation, redo: !redo, generation: generation, callback: callback)
        }
        undoManager?.setActionName("Attach content")
    }
    /// Announced so dictation can hand images straight to this box rather than
    /// posting a synthetic ⌘V at it — see registerComposerImageSink.
    public var onFocusChange: ((Bool) -> Void)?

    public override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { onFocusChange?(true) }
        return ok
    }

    public override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok { onFocusChange?(false) }
        return ok
    }

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
    public func stagePasteboardImage() -> Bool {
        precondition(Thread.isMainThread)
        let board = composerPasteboard
        let imageType = board.availableType(from: [.png, .tiff, NSPasteboard.PasteboardType("public.jpeg"), NSPasteboard.PasteboardType("com.compuserve.gif"), NSPasteboard.PasteboardType("org.webmproject.webp")])
        let hasImage = imageType != nil
        let hasText = board.string(forType: .string) != nil
        guard composerPasteAction(hasImage: hasImage, hasText: hasText) == .stageImage else {
            return false
        }
        // Capture immutable encoded bytes on AppKit's thread. No image object,
        // representation conversion or decode is materialized on that thread.
        guard let imageType, let data = board.data(forType: imageType) else {
            onAdmissionError?("The pasted image is unavailable. Copy it again.")
            return false
        }
        stageAsync(name: "Pasted image") {
            guard let bitmap = NSBitmapImageRep(data: data),
                  let png = bitmap.representation(using: .png, properties: [:]) else {
                throw NSError(domain: "UnmuteAttachment", code: 1, userInfo: [NSLocalizedDescriptionKey: "This pasted image could not be converted to PNG."])
            }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("unmute-draft-\(UUID().uuidString).png")
            try png.write(to: url)
            return (url.path, "image/png", url.lastPathComponent)
        }
        return true
    }

    public override func paste(_ sender: Any?) {
        if stagePasteboardImage() { return }
        if let urls = composerPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            for url in urls { stageFile(url) }
            return
        }
        if let pasted = composerPasteboard.string(forType: .string), stagingTaskId == "unmute-agent" {
            // Agent durability currently owns a text draft, not task attachment
            // records. Keep even very large paste literal so it reaches that
            // draft instead of disappearing into an unsupported task ID.
            insertText(pasted, replacementRange: selectedRange())
            return
        }
        if let pasted = composerPasteboard.string(forType: .string),
           shouldCollapseComposerPaste(pasted, policy: pastePolicy) {
            let displayName = "Pasted text · \(pasted.components(separatedBy: "\n").count) lines"
            stageAsync(name: displayName) {
                let url = FileManager.default.temporaryDirectory.appendingPathComponent("unmute-draft-\(UUID().uuidString).txt")
                try pasted.write(to: url, atomically: true, encoding: .utf8)
                return (url.path, "text/x-unmute-paste", displayName)
            }
            return
        }
        super.paste(sender)
    }

    private func stageFile(_ url: URL) {
        guard url.isFileURL else { return }
        stageAsync(name: url.lastPathComponent, sourcePath: url.path) { try stageComposerFile(url) }
    }

    public override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) { return .copy }
        return super.draggingEntered(sender)
    }

    public override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            for url in urls { stageFile(url) }
            return true
        }
        return super.performDragOperation(sender)
    }
}
