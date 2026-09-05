import Foundation

public struct ComposerPastePolicy: Equatable {
    public static let `default` = ComposerPastePolicy(characterThreshold: 900, lineThreshold: 12)
    public let characterThreshold: Int
    public let lineThreshold: Int
    public init(characterThreshold: Int, lineThreshold: Int) {
        self.characterThreshold = characterThreshold; self.lineThreshold = lineThreshold
    }
}

public func shouldCollapseComposerPaste(_ text: String, policy: ComposerPastePolicy = .default) -> Bool {
    text.count >= policy.characterThreshold || text.components(separatedBy: "\n").count >= policy.lineThreshold
}

public func composerAttachmentError(isRegularFile: Bool, byteCount: Int, mimeType: String = "application/octet-stream", attachmentCount: Int = 0, totalBytes: Int = 0) -> String? {
    guard isRegularFile else { return "Choose a file; folders cannot be attached." }
    guard attachmentCount < 10 else { return "Attach up to 10 items per message." }
    let image = mimeType.hasPrefix("image/")
    if image && !["image/png", "image/jpeg", "image/gif", "image/webp"].contains(mimeType) {
        return "Choose a PNG, JPEG, GIF or WebP image."
    }
    guard byteCount <= (image ? 10 : 25) * 1024 * 1024 else { return image ? "Images must be 10 MB or smaller." : "Files must be 25 MB or smaller." }
    guard totalBytes + byteCount <= 50 * 1024 * 1024 else { return "Attachments must total 50 MB or less." }
    return nil
}
