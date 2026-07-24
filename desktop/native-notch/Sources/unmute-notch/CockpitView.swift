import SwiftUI

// The full wall (~80% of the screen), rendered NATIVELY inside the same morphing
// panel — no separate Electron window. Fed CockpitData over the JSON channel.
// A grid of session cards on the left, a rail (queue / projects / suggestions)
// on the right, and a "voice → new task" footer. Monochrome; status shows as a
// small colored dot.
struct CockpitView: View {
    @ObservedObject var model: NotchModel

    private var data: CockpitData { model.cockpit ?? CockpitData(tasks: [], queue: [], projects: [], suggestions: []) }
    private let cols = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            // Left: session cards.
            ScrollView {
                LazyVGrid(columns: cols, alignment: .leading, spacing: 12) {
                    ForEach(data.tasks, id: \.id) { card($0) }
                }.padding(18)
            }
            // Right rail.
            rail
                .frame(width: 300)
                .frame(maxHeight: .infinity, alignment: .top)
                .background(Color.white.opacity(0.02))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 18) // clear the notch
        .overlay(alignment: .bottomLeading) {
            HStack(spacing: 8) {
                Image(systemName: "mic.fill").font(.system(size: 11)).foregroundColor(Theme.textDim)
                Text("voice → new task").font(.system(size: 13)).foregroundColor(Theme.textDim)
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(RoundedRectangle(cornerRadius: 10).stroke(Theme.hairline, lineWidth: 1))
            .padding(18)
        }
    }

    private func card(_ t: CockpitTask) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle().fill(statusColor(t.status)).frame(width: 7, height: 7)
                Text(t.status.uppercased() + (t.age.map { " · \($0)" } ?? ""))
                    .font(.system(size: 11, weight: .medium)).tracking(0.6)
                    .foregroundColor(statusColor(t.status))
            }
            Text(t.title).font(.system(size: 15, weight: .medium)).foregroundColor(Theme.text).lineLimit(1)
            if let sub = t.subtitle, !sub.isEmpty {
                Text(sub).font(.system(size: 12)).foregroundColor(Theme.textDim).lineLimit(2)
            }
            if let p = t.path, !p.isEmpty {
                Text(p).font(.system(size: 11, design: .monospaced)).foregroundColor(Color(white: 0.42)).lineLimit(1)
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(white: 0.06)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.hairline, lineWidth: 1))
    }

    private var rail: some View {
        VStack(alignment: .leading, spacing: 20) {
            railSection("QUEUE · \(data.queue.count)", data.queue, live: true)
            railSection("PROJECTS", data.projects, live: false)
            railSection("SUGGESTIONS · \(data.suggestions.count)", data.suggestions, live: false, isNew: true)
            Spacer(minLength: 0)
        }.padding(18)
    }

    private func railSection(_ title: String, _ items: [String], live: Bool, isNew: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 11, weight: .medium)).tracking(1.0).foregroundColor(Theme.textDim)
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(spacing: 8) {
                    if live { Circle().fill(Theme.accentDim).frame(width: 6, height: 6) }
                    if isNew { Text("NEW").font(.system(size: 9, weight: .bold)).foregroundColor(Theme.accent) }
                    Text(item).font(.system(size: 13)).foregroundColor(Theme.text).lineLimit(1)
                }
            }
        }
    }

    private func statusColor(_ s: String) -> Color {
        switch s {
        case "running", "processing": return Color(red: 0.37, green: 0.72, blue: 0.91) // live blue
        case "blocked", "needs-user", "stuck", "errored", "failed": return Theme.accent // amber
        default: return Color(white: 0.35) // done / neutral
        }
    }
}
