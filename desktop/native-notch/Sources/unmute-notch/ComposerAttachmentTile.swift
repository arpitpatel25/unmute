import SwiftUI
import AppKit
import ComposerSupport

struct ComposerAttachmentTile: View {
    let attachment: DraftAttachmentP
    let remove: () -> Void
    let restore: () -> Void
    var readOnly = false
    var knownBytes: Int? = nil
    /// `.chip` in the composer (its tray and the saved follow-up); `.tile`
    /// in the conversation, where the picture IS the content and keeps its
    /// full thumbnail.
    var style: Style = .tile
    enum Style { case tile, chip }
    @State private var previewing = false
    @StateObject private var preview = ComposerAttachmentPreview()
    private var isPaste: Bool { attachment.mimeType == "text/x-unmute-paste" }
    private var image: NSImage? { preview.image }
    private var visualState: AttachmentVisualState {
        attachmentVisualState(isImage: attachment.mimeType.hasPrefix("image/"), fileExists: preview.canUse, imageDecoded: image != nil)
    }
    private var pasteText: String? { preview.text }
    // Generated capture names are storage identifiers, not useful titles.
    // Keep the original name in the tooltip; imported files retain their names.
    private var displayName: String {
        let name = URL(fileURLWithPath: attachment.name).lastPathComponent
        if isPaste { return "Pasted text" }
        if attachment.mimeType.hasPrefix("image/") &&
            (name.contains("Unmute-") || name.hasPrefix("attachment-") || UUID(uuidString: (name as NSString).deletingPathExtension) != nil) {
            return "Image"
        }
        return name
    }
    private var metadata: String {
        let bytes = knownBytes.map(Int64.init) ?? preview.bytes
        return "\(attachment.name)\n\(attachment.mimeType) · \(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))"
    }
    /// The chip's 24pt leading square: the picture itself when there is one,
    /// otherwise what kind of thing this is.
    @ViewBuilder private var leading: some View {
        if preview.loading {
            ProgressView().controlSize(.small).scaleEffect(0.7)
        } else if let image {
            Image(nsImage: image).resizable().scaledToFill()
        } else {
            Image(systemName: visualState == .unavailableImage ? "exclamationmark.triangle"
                  : isPaste ? "text.alignleft" : "doc")
                .font(.system(size: 11))
                .foregroundColor(visualState == .unavailableImage ? Theme.cError : Theme.textDim)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.raised)
        }
    }

    var body: some View {
        Group {
            if style == .chip { chipBody } else { tileBody }
        }
        .contextMenu {
            Button("Preview") { previewing = true }.disabled(!preview.canUse)
            Button("Copy") { copy() }.disabled(!preview.canUse)
            if isPaste && !readOnly { Button("Edit in composer", action: restore).disabled(!preview.canUse) }
            if !readOnly { Button("Remove", action: remove) }
        }
        .popover(isPresented: $previewing) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 12) {
                    Label(displayName, systemImage: image != nil ? "photo" : isPaste ? "text.alignleft" : "doc")
                        .font(Theme.fBodyMed).lineLimit(1).truncationMode(.middle)
                        .help(attachment.name)
                    Spacer()
                    KeyButton(label: "Done") { previewing = false }.keyboardShortcut(.cancelAction)
                }
                if let image {
                    Image(nsImage: image).resizable().scaledToFit()
                        .frame(maxWidth: .infinity, maxHeight: 420)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                } else if let text = pasteText {
                    ScrollView { Text(text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                        .frame(width: 440, height: 260)
                } else if visualState == .unavailableImage {
                    Text("This image is unavailable or could not be decoded.").foregroundColor(Theme.cError)
                } else {
                    Text(metadata).textSelection(.enabled)
                    KeyButton(label: "Open file", symbol: "arrow.up.forward.square") { IPC.emit(.openArtifact(type: "path", value: attachment.path)) }
                }
                HStack(spacing: 8) {
                    KeyButton(label: image != nil ? "Copy image" : "Copy", symbol: "doc.on.doc") { copy() }.disabled(!preview.canUse)
                    if isPaste && !readOnly { KeyButton(label: "Edit in composer", symbol: "square.and.pencil") { previewing = false; restore() } }
                    Spacer()
                    Text(ByteCountFormatter.string(fromByteCount: knownBytes.map(Int64.init) ?? preview.bytes, countStyle: .file))
                        .font(Theme.fCap).foregroundColor(Theme.textFaint)
                        .help(metadata)
                }
            }.padding(20).frame(width: 520)
        }
        .task(id: attachment.path) { preview.load(path: attachment.path, mime: attachment.mimeType) }
    }

    /// A CHIP, NOT A TILE. The tile was a 100×72 thumbnail padded to 88pt in a
    /// 66pt strip, so it cost the conversation 72pt per row and its top was
    /// cut off by the composer's own outline. The chip is 30pt: enough of the
    /// picture to tell WHICH screenshot it is (the reason the preview exists),
    /// with the full image one click away in the same popover as before.
    private var chipBody: some View {
        HStack(spacing: 6) {
            Button { previewing = true } label: {
                HStack(spacing: 6) {
                    leading
                        .frame(width: 24, height: 24)
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                    VStack(alignment: .leading, spacing: 0) {
                        Text(displayName).font(.system(size: 11.5)).foregroundColor(Theme.textDim)
                            .lineLimit(1).truncationMode(.middle)
                        if visualState == .unavailableImage {
                            Text("Image unavailable").font(.system(size: 9.5)).foregroundColor(Theme.cError).lineLimit(1)
                        }
                    }
                    .frame(maxWidth: 140, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).help(metadata).accessibilityLabel("Preview \(displayName)")
            .disabled(!preview.canUse)
            if !readOnly {
                Button(action: remove) {
                    Image(systemName: "xmark").font(.system(size: 9, weight: .semibold))
                        .foregroundColor(Theme.textFaint).frame(width: 16, height: 24)
                        .contentShape(Rectangle())
                }
                    .buttonStyle(.plain).help("Remove attachment").accessibilityLabel("Remove \(displayName)")
            }
        }
        .padding(.leading, 3).padding(.trailing, readOnly ? 8 : 4)
        .frame(height: 30)
        .fixedSize()
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.sunken))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.hairline, lineWidth: 0.5))
    }

    /// The conversation's thumbnail: a picture you sent, or one the agent
    /// fetched as part of its answer.
    private var tileBody: some View {
        HStack(spacing: 4) {
            Button { previewing = true } label: {
                if preview.loading {
                    HStack { ProgressView().controlSize(.small); Text("Loading preview…").font(.system(size: 10)) }
                        .frame(width: 150, height: 52)
                } else if let image {
                    Image(nsImage: image).resizable().scaledToFit()
                        .frame(width: 100, height: 72)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                } else if visualState == .unavailableImage {
                    VStack(alignment: .leading, spacing: 3) {
                        Label(displayName, systemImage: "exclamationmark.triangle")
                            .font(.system(size: 11.5)).lineLimit(1)
                        Text("Image unavailable").font(.system(size: 10)).foregroundColor(Theme.cError)
                    }.frame(width: 150, height: 52, alignment: .leading)
                } else {
                    VStack(alignment: .leading, spacing: 3) {
                        Label(displayName, systemImage: isPaste ? "text.alignleft" : "doc")
                            .font(.system(size: 11.5)).lineLimit(1)
                        if isPaste { Text(pasteText?.prefix(75) ?? "Unable to read pasted text").lineLimit(2).font(.system(size: 10)) }
                    }.frame(width: 150, height: 52, alignment: .leading)
                }
            }
            .buttonStyle(.plain).help(metadata).accessibilityLabel("Preview \(displayName)")
            .disabled(!preview.canUse)
            if !readOnly {
                Button(action: remove) {
                    Image(systemName: "xmark").font(Theme.controlIcon)
                        .foregroundColor(Theme.textDim).frame(width: 24, height: 28)
                }
                    .buttonStyle(.plain).help("Remove attachment").accessibilityLabel("Remove \(displayName)")
            }
        }
        .padding(6)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.sunken))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.hairline, lineWidth: 0.5))
    }

    private func copy() {
        guard preview.canUse else { return }
        NSPasteboard.general.clearContents()
        if let text = pasteText { NSPasteboard.general.setString(text, forType: .string) }
        else if let bytes = preview.encodedImage {
            let type: NSPasteboard.PasteboardType = attachment.mimeType == "image/png" ? .png
                : .init(attachment.mimeType == "image/jpeg" ? "public.jpeg" : attachment.mimeType == "image/gif" ? "com.compuserve.gif" : "org.webmproject.webp")
            NSPasteboard.general.setData(bytes, forType: type)
        }
        else { NSPasteboard.general.writeObjects([URL(fileURLWithPath: attachment.path) as NSURL]) }
    }
}
