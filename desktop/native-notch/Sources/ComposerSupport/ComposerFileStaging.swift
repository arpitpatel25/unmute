import AppKit
import UniformTypeIdentifiers

/// Returns a disposable handoff copy; never sends the user's original file.
public func stageComposerFile(_ url: URL) throws -> (path: String, mime: String, name: String) {
    let resource = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
    var mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    var data: Data? = nil
    if mime == "image/tiff", resource.isRegularFile == true {
        guard let image = NSImage(contentsOf: url), let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else {
            throw NSError(domain: "UnmuteAttachment", code: 1, userInfo: [NSLocalizedDescriptionKey: "This TIFF image could not be converted to PNG."])
        }
        data = png
        mime = "image/png"
    }
    if let error = composerAttachmentError(isRegularFile: url.isFileURL && resource.isRegularFile == true,
                                          byteCount: data?.count ?? resource.fileSize ?? 0, mimeType: mime) {
        throw NSError(domain: "UnmuteAttachment", code: 1, userInfo: [NSLocalizedDescriptionKey: error])
    }
    let converted = data != nil
    let staged = FileManager.default.temporaryDirectory.appendingPathComponent("unmute-draft-\(UUID().uuidString).\(converted ? "png" : url.pathExtension)")
    if let data { try data.write(to: staged) }
    else { try FileManager.default.copyItem(at: url, to: staged) }
    return (staged.path, mime, converted ? url.deletingPathExtension().lastPathComponent + ".png" : url.lastPathComponent)
}

/// Dispose only the private handoff shape this process creates.
public func disposeComposerHandoff(_ path: String) {
    let url = URL(fileURLWithPath: path)
    guard url.deletingLastPathComponent().standardizedFileURL == FileManager.default.temporaryDirectory.standardizedFileURL,
          url.lastPathComponent.hasPrefix("unmute-draft-") else { return }
    try? FileManager.default.removeItem(at: url)
}
