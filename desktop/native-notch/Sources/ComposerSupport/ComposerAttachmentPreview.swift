import AppKit
import Combine
import ImageIO

/// File reads and eager thumbnail decoding happen on the worker. SwiftUI only
/// observes the resulting state, never reads a file while computing its body.
public final class ComposerAttachmentPreview: ObservableObject {
    @Published public private(set) var loading = true
    @Published public private(set) var image: NSImage?
    public private(set) var encodedImage: Data?
    @Published public private(set) var text: String?
    @Published public private(set) var bytes: Int64 = 0
    @Published public private(set) var canUse = false
    private var generation = UUID()
    public init() {}

    public func load(path: String, mime: String, completion: (() -> Void)? = nil) {
        let token = UUID(); generation = token
        loading = true; canUse = false; image = nil; text = nil; encodedImage = nil
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let attrs = try? FileManager.default.attributesOfItem(atPath: path)
            let size = (attrs?[.size] as? NSNumber)?.int64Value ?? 0
            var decoded: NSImage?, content: String?
            let isImage = mime.hasPrefix("image/")
            let encoded = isImage ? try? Data(contentsOf: URL(fileURLWithPath: path)) : nil
            if let encoded, let source = CGImageSourceCreateWithData(encoded as CFData, nil),
               let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: 960,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
               ] as CFDictionary) {
                decoded = NSImage(cgImage: thumbnail, size: .zero)
            } else if mime == "text/x-unmute-paste" {
                content = try? String(contentsOfFile: path, encoding: .utf8)
            }
            let available = isImage ? decoded != nil : mime == "text/x-unmute-paste" ? content != nil : attrs != nil
            DispatchQueue.main.async {
                guard let self, self.generation == token else { return }
                self.image = decoded; self.text = content; self.bytes = size
                self.encodedImage = encoded
                self.canUse = available; self.loading = false; completion?()
            }
        }
    }
}
