import SwiftUI

struct HelpGuideView: View {
    let guide: HelpGuideP
    let close: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 9) {
                UnMark(height: 13)
                Text(guide.title).font(Theme.fTitle).foregroundColor(Theme.text)
                Spacer()
                CloseButton(action: close)
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.vertical, 10)
            .background(Theme.railBg)

            Rectangle().fill(Theme.hairlineSoft).frame(height: 1)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(guide.sections) { section in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(section.title).font(Theme.fTitle).foregroundColor(Theme.text)
                            Text(section.intro).font(Theme.fSub).foregroundColor(Theme.textDim)
                                .fixedSize(horizontal: false, vertical: true)
                            ForEach(section.entries) { entry in
                                entryCard(entry)
                            }
                        }
                    }

                    Text("Still unsure? Ask the Unmute Agent any “How do I…?” question.")
                        .font(Theme.fSub).foregroundColor(Theme.textDim)
                        .padding(.bottom, 8)
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.vertical, 16)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
    }

    private func entryCard(_ entry: HelpGuideEntryP) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(entry.title).font(Theme.fBody.weight(.semibold)).foregroundColor(Theme.text)
            Text(entry.summary).font(Theme.fSub).foregroundColor(Theme.textDim)
                .fixedSize(horizontal: false, vertical: true)
            if let shortcut = entry.shortcut {
                Text(shortcut).font(Theme.fSub.weight(.semibold)).foregroundColor(Theme.text)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: Theme.controlRadius).fill(Theme.raised))
            }
            ForEach(entry.steps ?? [], id: \.self) { step in
                Text("• \(step)").font(Theme.fSub).foregroundColor(Theme.textDim)
            }
            if let example = entry.example {
                Text("Example: \(example)").font(Theme.fSub).italic().foregroundColor(Theme.textFaint)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius).fill(Theme.raised))
    }
}
