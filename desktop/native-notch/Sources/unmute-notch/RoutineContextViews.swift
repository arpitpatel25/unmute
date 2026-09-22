import SwiftUI
import AppKit

func routineJSON<T: Encodable>(_ value: T) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(value), let text = String(data: data, encoding: .utf8) else { return "{}" }
    return text
}

struct RoutineContextSummary: View {
    let inputs: [String]
    let context: RoutineContextP
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Sources: \(inputs.isEmpty ? "reference files / prompt only" : inputs.joined(separator: ", "))")
            if inputs.contains("sessions") {
                Text(context.folders.isEmpty && context.sessionIds.isEmpty
                     ? "Sessions: all indexed projects in the time period"
                     : "Sessions: \(context.folders.count) project folders + \(context.sessionIds.count) selected sessions")
                ForEach(context.folders, id: \.self) { Text($0).textSelection(.enabled) }
                ForEach(context.sessionIds, id: \.self) { Text("Session: \($0)").textSelection(.enabled) }
            }
            ForEach(context.files, id: \.self) { Text("Reference: \($0)").textSelection(.enabled) }
            if inputs.contains("meetings"), !(context.meetingIds ?? []).isEmpty {
                ForEach(context.meetingIds ?? [], id: \.self) { Text("Meeting: \($0)").textSelection(.enabled) }
            }
            ForEach(context.excludedFolders, id: \.self) { Text("Exclude folder: \($0)").textSelection(.enabled) }
            ForEach(context.excludedSessionIds, id: \.self) { Text("Exclude session: \($0)").textSelection(.enabled) }
        }
        .font(.system(size: 11.5)).foregroundColor(Theme.textDim)
        .fixedSize(horizontal: false, vertical: true)
    }
}

struct RoutineContextEditor: View {
    @Binding var inputs: [String]
    @Binding var context: RoutineContextP
    let catalog: RoutineContextCatalogP?
    @State private var sessionSearch = ""
    @State private var showSessions = false
    @State private var manualSession = ""
    @State private var meetingId = ""

    private var sessions: [RoutineContextCatalogP.Session] {
        (catalog?.sessions ?? []).filter { sessionSearch.isEmpty || $0.label.localizedCaseInsensitiveContains(sessionSearch) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Context").font(Theme.fBodyMed).foregroundColor(Theme.text)
            HStack(spacing: 10) {
                ForEach(["sessions", "memory", "meetings", "dictation"], id: \.self) { source in
                    Toggle(source.capitalized, isOn: Binding(
                        get: { inputs.contains(source) },
                        set: { on in inputs.removeAll { $0 == source }; if on { inputs.append(source) } }
                    )).toggleStyle(.checkbox).font(.system(size: 11.5))
                }
            }
            if inputs.contains("sessions") {
                Text("Project folders and sessions").font(.system(size: 12, weight: .medium))
                Text("Choose neither to include all indexed sessions. Choose either to narrow the selection; exclusions always win. Folders include subfolders and select session history, not every file in the folder.")
                    .font(.system(size: 11)).foregroundColor(Theme.textDim)
                HStack {
                    Menu("Choose indexed project") {
                        ForEach(catalog?.folders ?? [], id: \.self) { folder in
                            Button(folder) { append(folder, to: &context.folders) }
                        }
                    }.fixedSize().disabled((catalog?.folders ?? []).isEmpty)
                    QuietButton(label: "Browse folder…") { chooseFolders(exclude: false) }
                }
                pathRows(context.folders) { path in context.folders.removeAll { $0 == path } }
                DisclosureGroup("Select sessions", isExpanded: $showSessions) {
                    VStack(alignment: .leading, spacing: 5) {
                        TextField("Search recent sessions", text: $sessionSearch).textFieldStyle(.roundedBorder)
                        Text("Up to 100 recent indexed sessions; paste an ID below for an older session.")
                            .font(.system(size: 11)).foregroundColor(Theme.textDim)
                        ForEach(sessions.prefix(12), id: \.id) { session in
                            HStack(alignment: .top) {
                                Toggle(isOn: Binding(get: { context.sessionIds.contains(session.id) }, set: { on in
                                    context.sessionIds.removeAll { $0 == session.id }
                                    if on { append(session.id, to: &context.sessionIds) }
                                })) { Text(session.label).lineLimit(2) }
                                    .toggleStyle(.checkbox)
                                QuietButton(label: "Exclude") { append(session.id, to: &context.excludedSessionIds) }
                            }.font(.system(size: 11.5))
                        }
                        HStack {
                            TextField("Session ID", text: $manualSession).textFieldStyle(.roundedBorder)
                            QuietButton(label: "Add") { addSession(exclude: false) }
                            QuietButton(label: "Exclude") { addSession(exclude: true) }
                        }
                    }
                }
                pathRows(context.sessionIds) { id in context.sessionIds.removeAll { $0 == id } }
            }
            if inputs.contains("memory") || inputs.contains("meetings") || inputs.contains("dictation") {
                Text("Memory, meetings and dictation are retrieved by relevance using the selected categories and time period. Session folder filters do not apply to these sources.")
                    .font(.system(size: 11)).foregroundColor(Theme.textDim)
            }
            if inputs.contains("meetings") {
                Text("Meetings: leave empty for relevant meetings in the time period, or select specific meetings.")
                    .font(.system(size: 11)).foregroundColor(Theme.textDim)
                Menu("Select a recorded meeting") {
                    ForEach(catalog?.meetings ?? [], id: \.id) { meeting in
                        Button(meeting.title) {
                            var ids = context.meetingIds ?? []; append(meeting.id, to: &ids); context.meetingIds = ids
                        }
                    }
                }.fixedSize().disabled((catalog?.meetings ?? []).isEmpty)
                HStack {
                    TextField("Meeting ID", text: $meetingId).textFieldStyle(.roundedBorder)
                    QuietButton(label: "Add") {
                        let id = meetingId.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !id.isEmpty { var ids = context.meetingIds ?? []; append(id, to: &ids); context.meetingIds = ids; meetingId = "" }
                    }
                }
                pathRows(context.meetingIds ?? []) { id in context.meetingIds?.removeAll { $0 == id } }
            }
            if inputs.contains("dictation") {
                Text("Dictation history is limited to retained captures, roughly the last day.")
                    .font(.system(size: 11)).foregroundColor(Theme.textFaint)
            }
            HStack {
                Text("Reference files").font(.system(size: 12, weight: .medium))
                Spacer()
                QuietButton(label: "Attach files…") { chooseFiles() }
            }
            Text("Text previews: up to 32 KB per file, 128 KB total. Missing or unreadable files are reported in run context.")
                .font(.system(size: 11)).foregroundColor(Theme.textDim)
            pathRows(context.files) { path in context.files.removeAll { $0 == path } }
            HStack {
                Text("Exclusions").font(.system(size: 12, weight: .medium))
                Spacer()
                QuietButton(label: "Exclude folder…") { chooseFolders(exclude: true) }
            }
            pathRows(context.excludedFolders) { path in context.excludedFolders.removeAll { $0 == path } }
            pathRows(context.excludedSessionIds) { id in context.excludedSessionIds.removeAll { $0 == id } }
            RoutineContextSummary(inputs: inputs, context: context)
            Text("These choices select run context; they are not a filesystem permission boundary.")
                .font(.system(size: 11)).foregroundColor(Theme.textFaint)
        }.fixedSize(horizontal: false, vertical: true)
    }

    private func append(_ value: String, to list: inout [String]) {
        if !list.contains(value) && list.count < 100 { list.append(value) }
    }
    private func addSession(exclude: Bool) {
        let id = manualSession.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else { return }
        if exclude { append(id, to: &context.excludedSessionIds) }
        else { append(id, to: &context.sessionIds) }
        manualSession = ""
    }
    private func pathRows(_ values: [String], remove: @escaping (String) -> Void) -> some View {
        ForEach(values, id: \.self) { value in
            HStack(alignment: .top) {
                Text(value).font(.system(size: 11.5)).foregroundColor(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                Spacer(minLength: 3)
                Button { remove(value) } label: { Image(systemName: "xmark.circle") }
                    .buttonStyle(.plain).help("Remove \(value)")
            }
        }
    }
    private func chooseFolders(exclude: Bool) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = true
        panel.prompt = exclude ? "Exclude" : "Select"
        if panel.runModal() == .OK {
            for url in panel.urls {
                if exclude { append(url.path, to: &context.excludedFolders) }
                else { append(url.path, to: &context.folders) }
            }
        }
    }
    private func chooseFiles() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false; panel.canChooseFiles = true; panel.allowsMultipleSelection = true
        panel.prompt = "Attach"
        if panel.runModal() == .OK { for url in panel.urls { append(url.path, to: &context.files) } }
    }
}
