import SwiftUI
import ComposerSupport

struct ComposerStagingTile: View {
    let item: ComposerStagingRecord
    let retry: () -> Void
    let remove: () -> Void

    /// The same 30pt chip as a staged attachment (ComposerAttachmentTile), so a
    /// file does not change size as it goes from preparing to ready. A failure
    /// says so in red; the full reason is on hover and read aloud.
    var body: some View {
        HStack(spacing: 6) {
            Group {
                if item.phase == .failed {
                    Image(systemName: "exclamationmark.triangle").font(.system(size: 11)).foregroundColor(Theme.cError)
                } else {
                    ProgressView().controlSize(.small).scaleEffect(0.7)
                }
            }
            .frame(width: 24, height: 24)
            .background(RoundedRectangle(cornerRadius: 5).fill(Theme.raised))
            VStack(alignment: .leading, spacing: 0) {
                Text(item.name).font(.system(size: 11.5)).foregroundColor(Theme.textDim)
                    .lineLimit(1).truncationMode(.middle)
                Text(item.phase == .failed ? "Failed" : "Preparing…")
                    .font(.system(size: 9.5))
                    .foregroundColor(item.phase == .failed ? Theme.cError : Theme.textFaint)
            }
            .frame(maxWidth: 140, alignment: .leading)
            if item.phase == .failed, let source = item.sourcePath, FileManager.default.fileExists(atPath: source) {
                Button("Retry", action: retry).font(.system(size: 10.5)).buttonStyle(.borderless)
            }
            Button(action: remove) {
                Image(systemName: "xmark").font(.system(size: 9, weight: .semibold))
                    .foregroundColor(Theme.textFaint).frame(width: 16, height: 24)
                    .contentShape(Rectangle())
            }
                .buttonStyle(.plain).accessibilityLabel("Remove \(item.name)")
        }
        .padding(.leading, 3).padding(.trailing, 4)
        .frame(height: 30)
        .fixedSize()
        .help(item.phase == .failed ? (item.error ?? "Could not prepare attachment") : "Preparing \(item.name)")
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.sunken))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(item.phase == .failed ? Theme.cError.opacity(0.5) : Theme.hairline, lineWidth: 0.5))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(item.phase == .failed ? "\(item.name), failed: \(item.error ?? "unknown error")" : "\(item.name), preparing")
    }
}
