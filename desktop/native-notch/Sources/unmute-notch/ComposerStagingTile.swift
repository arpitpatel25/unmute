import SwiftUI
import ComposerSupport

struct ComposerStagingTile: View {
    let item: ComposerStagingRecord
    let retry: () -> Void
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 4) {
                Label(item.name, systemImage: item.phase == .failed ? "exclamationmark.triangle" : "clock")
                    .font(.system(size: 11.5)).lineLimit(1)
                if item.phase == .failed {
                    Text(item.error ?? "Could not prepare attachment")
                        .font(.system(size: 10)).foregroundColor(Theme.cError).lineLimit(2)
                    if let source = item.sourcePath, FileManager.default.fileExists(atPath: source) {
                        Button("Retry", action: retry).font(.system(size: 10))
                    }
                } else {
                    Text("Preparing…").font(.system(size: 10)).foregroundColor(Theme.textFaint)
                }
            }.frame(width: 150, height: 52, alignment: .leading)
            Button(action: remove) { Image(systemName: "xmark").frame(width: 28, height: 28) }
                .buttonStyle(.plain).accessibilityLabel("Remove \(item.name)")
        }
        .padding(4)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.sunken))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(item.phase == .failed ? Theme.cError.opacity(0.5) : Theme.hairline, lineWidth: 0.5))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(item.phase == .failed ? "\(item.name), failed: \(item.error ?? "unknown error")" : "\(item.name), preparing")
    }
}
