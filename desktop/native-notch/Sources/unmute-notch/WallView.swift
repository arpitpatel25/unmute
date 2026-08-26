import SwiftUI
import WallPresentationSupport

// The Orchestrator wall — group sections of cards plus the sidebar (queue /
// one-offs / skills / shelf), the away digest, doorbell and the
// route offer. Clicking a card emits focusTask (the voice address) and the
// Stage takes over (StageView).
//
// GOLDEN GATE: the sidebar is EDGE-TO-EDGE, not an inset floating pane — Tahoe's
// floating sidebar was removed in the 27 design. Both scrollers carry a hard
// scroll-edge effect so content dissolves under the pinned chrome rather than
// colliding with it.
struct WallView: View {
    @ObservedObject var model: NotchModel
    let topInset: CGFloat
    /// The row awaiting confirmation, if any. Import puts a card on the wall
    /// that was not there a moment ago, so a stray click in a scrolling list
    /// must not do it.
    @State private var confirmImport: ImportableP? = nil
    /// The import rail is open by default — it is how you discover the feature —
    /// but collapsible, because once you have brought in what you wanted it is
    /// the longest thing on the rail and the least useful.
    @State private var importOpen = true
    /// Backends whose full list the user asked for.
    @State private var importExpanded: Set<String> = []
    /// Presentation-only views over the wall. The engine still owns the task
    /// data, order, folds and Today query; these never mutate a task.
    @State private var selectedView: WallViewMode
    @State private var selectedWorkspace: WallWorkspaceSelection = .all
    /// Local disclosure for the combined All work / All workspaces overview.
    /// The engine still reveals its folded history; this only keeps each
    /// workspace preview scannable until the user opens that one section.
    @State private var expandedWorkspacePreviews: Set<String> = []

    init(model: NotchModel, topInset: CGFloat) {
        self.model = model
        self.topInset = topInset
        _selectedView = State(initialValue:
            WallLaunchPresentation.resolve(todayOnly: model.cockpit?.todayOnly).view)
    }

    private var data: CockpitData {
        model.cockpit ?? CockpitData(groups: [], hiddenTotal: 0, showingAll: false, todayOnly: false,
                                     queue: [], oneoffs: [],
                                     unmuteSkills: [], skills: [], shelf: [], importable: [],
                                     digest: nil, doorbell: true,
                                     routeOffer: nil, tmuxAvailable: false)
    }

    var body: some View {
        VStack(spacing: 0) {
            headerChrome
            Rectangle().fill(Theme.hairlineSoft).frame(height: 1)
            HStack(alignment: .top, spacing: 0) {
                workspaceRail
                // THE FLOATING CHROME BELONGS TO THE MAIN COLUMN, NOT THE
                // SURFACE. It describes the work in the centre, while the
                // activity rail keeps its own rows reachable all the way down.
                main
                    .overlay(alignment: .bottom) { bottomChrome }
                rail
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(alignment: .topLeading) { hoverCard }
        .onAppear { activateLaunchView() }
        .onChange(of: data.hiddenTotal) { _ in revealAllIfNeeded() }
        .onChange(of: data.showingAll) { _ in revealAllIfNeeded() }
    }

    // MARK: main column

    private var main: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                wallTitle

                if let digest = data.digest { digestBanner(digest) }

                // "Nothing here" means nothing EXISTS — not "everything is
                // folded", which is a different thing with a way out.
                if visibleGroups.isEmpty, let emptyMessage {
                    Text(emptyMessage)
                        .font(Theme.fBody).foregroundColor(Theme.textFaint)
                        .padding(.top, 34).frame(maxWidth: .infinity, alignment: .center)
                }

                // A GROUP KEEPS ITS HEADER WHEN EVERYTHING IN IT IS FOLDED.
                // Skipping empty groups silently deleted whole groups from the
                // wall once folding arrived, taking their "show all" with them
                // and making those tasks unreachable by any gesture.
                ForEach(Array(visibleGroups.enumerated()), id: \.offset) { _, group in
                    groupSection(group)
                }
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.top, 18)
            .padding(.bottom, 60)
        }
        .scrollEdge(topInset + 18)
        .alert("Import this session?",
               isPresented: Binding(get: { confirmImport != nil },
                                    set: { if !$0 { confirmImport = nil } }),
               presenting: confirmImport) { row in
            Button("Import") { model.emit(.importSession(sessionId: row.sessionId)); confirmImport = nil }
            Button("Cancel", role: .cancel) { confirmImport = nil }
        } message: { row in
            Text("\(row.title) — from \(row.project). It keeps its full history and nothing starts running until you speak to it.")
        }
    }

    /// One compact, cutout-safe header. `topInset` keeps this entire row below
    /// a physical camera housing; the same row simply sits nearer the top on a
    /// display without one.
    private var headerChrome: some View {
        HStack(spacing: 10) {
            UnMark(height: 13)
            SectionLabel(text: "Orchestrator")
            HStack(spacing: 4) {
                ForEach(WallViewMode.allCases, id: \.rawValue) { mode in
                    wallViewButton(mode)
                }
            }
            Spacer(minLength: 0)
            if data.groups.flatMap(\.cards).contains(where: { $0.status == .processing }) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 6) {
                        Dot(status: .processing, size: 6, breathing: true)
                        Text("System moving").font(Theme.fCap).foregroundColor(Theme.textDim)
                    }
                    Dot(status: .processing, size: 6, breathing: true)
                }
            }
            if model.canGoBack { BackButton { model.onBack() } }
            CloseButton { model.emit(.collapsed) }
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.top, topInset)
        .padding(.bottom, 9)
        .background(Theme.railBg)
    }

    private func wallViewButton(_ mode: WallViewMode) -> some View {
        let selected = selectedView == mode
        return Button(action: { selectView(mode) }) {
            Text(mode.title)
                .font(.system(size: 11.5, weight: selected ? .semibold : .medium))
                .foregroundColor(selected ? Theme.text : Theme.textDim)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: Theme.controlRadius)
                    .fill(selected ? Theme.raised : Color.clear))
        }
        .buttonStyle(.plain)
    }

    private func selectView(_ mode: WallViewMode) {
        selectedView = mode
        let today = mode == .today
        if (data.todayOnly ?? false) != today { model.emit(.today(on: today)) }
        revealAllIfNeeded()
    }

    private func activateLaunchView() {
        let launch = WallLaunchPresentation.resolve(todayOnly: data.todayOnly)
        selectedView = launch.view
        if launch.shouldEnableToday { model.emit(.today(on: true)) }
        revealAllIfNeeded()
    }

    private func revealAllIfNeeded() {
        if WallDisclosure.shouldReveal(hiddenTotal: data.hiddenTotal,
                                       showingAll: data.showingAll) {
            model.emit(.showAll(group: nil, on: true))
        }
    }

    private var wallTitle: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(selectedWorkspaceTitle == "All workspaces"
                 ? selectedView.title : selectedWorkspaceTitle)
                .font(Theme.fTitle).foregroundColor(Theme.text)
            Text(wallSubtitle).font(Theme.fSub).foregroundColor(Theme.textDim)
        }
    }

    private var wallSubtitle: String {
        let place = selectedWorkspaceTitle == "All workspaces"
            ? "across your workspaces" : "in \(selectedWorkspaceTitle)"
        switch selectedView {
        case .today: return "Work moving \(place) today."
        case .needsYou: return "Work waiting for your decision \(place)."
        case .finished: return "Recently finished work \(place)."
        case .allWork: return "All visible work \(place)."
        }
    }

    /// Nil where the emptiness speaks for itself.
    ///
    /// The needs-you view said "Nothing needs you here". Removed at the user's
    /// request: an empty list already says that, and being congratulated for
    /// having no work reads well once and grates every time after. Optional
    /// rather than an empty string, so the row is skipped entirely instead of
    /// leaving a padded blank where the text used to be.
    private var emptyMessage: String? {
        switch selectedView {
        case .needsYou: return nil
        case .finished: return "No finished work here"
        default: return "No sessions — speak to spawn one"
        }
    }

    private var selectedWorkspaceTitle: String {
        switch selectedWorkspace {
        case .all: return "All workspaces"
        case .named(let name): return name
        }
    }

    private var visibleGroups: [GroupP] {
        data.groups.compactMap { group in
            guard selectedWorkspace.includes(group: group.name) else { return nil }
            let cards = group.cards.filter { selectedView.includes(status: $0.status.rawValue) }
            let mayShowFold = selectedView == .today || selectedView == .allWork
            guard !cards.isEmpty || (mayShowFold && (group.hidden ?? 0) > 0) else { return nil }
            return GroupP(name: group.name, cards: cards,
                          hidden: mayShowFold ? group.hidden : 0,
                          expanded: group.expanded)
        }
    }

    // MARK: workspace rail

    private var workspaceRail: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 3) {
                SectionLabel(text: "Workspaces").padding(.horizontal, 8).padding(.bottom, 5)
                workspaceButton(.all, title: "All workspaces", count: data.groups.count,
                                active: data.groups.contains { $0.cards.contains { $0.status == .processing } })
                ForEach(Array(orderedWorkspaceGroups.enumerated()), id: \.offset) { _, group in
                    let title = group.name.isEmpty ? "Ungrouped" : group.name
                    workspaceButton(.named(title), title: title,
                                    count: group.cards.count + (group.hidden ?? 0),
                                    active: group.cards.contains { $0.status == .processing },
                                    ungrouped: group.name.isEmpty)
                }
            }
            .padding(.horizontal, 8)
            .padding(.top, 14)
            .padding(.bottom, 44)
        }
        .frame(width: 174)
        .background(Theme.railBg)
        .overlay(Rectangle().fill(Theme.hairlineSoft).frame(width: 1), alignment: .trailing)
    }

    private var orderedWorkspaceGroups: [GroupP] {
        let names = WallWorkspacePresentation.orderedNames(data.groups.map(\.name))
        return names.compactMap { title in
            data.groups.first { ($0.name.isEmpty ? "Ungrouped" : $0.name) == title }
        }
    }

    private func workspaceButton(_ selection: WallWorkspaceSelection,
                                 title: String, count: Int, active: Bool,
                                 ungrouped: Bool = false) -> some View {
        let selected = selectedWorkspace == selection
        let marker = ungrouped ? Theme.cNeeds.opacity(0.78) : Theme.accent
        return Button(action: { selectedWorkspace = selection }) {
            HStack(spacing: 8) {
                Circle()
                    .fill(ungrouped || active ? marker : Color.clear)
                    .overlay(Circle().stroke(ungrouped || active ? marker : Theme.textFaint,
                                             lineWidth: 0.75))
                    .frame(width: 6, height: 6)
                Text(title).font(Theme.fSub).foregroundColor(selected ? Theme.text : Theme.textDim)
                    .lineLimit(1)
                Spacer(minLength: 4)
                NumText(text: "\(count)")
            }
            .padding(.horizontal, 8).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Theme.controlRadius)
                .fill(selected && ungrouped
                      ? Theme.cNeeds.opacity(0.08)
                      : (selected ? Theme.raised : Color.clear)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func digestBanner(_ digest: String) -> some View {
        Button(action: { model.emit(.digestDismiss) }) {
            HStack(spacing: 10) {
                Image(systemName: "moon.zzz")
                    .font(.system(size: 12)).foregroundColor(Theme.accent)
                Text(digest)
                    .font(Theme.fSub).foregroundColor(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold)).foregroundColor(Theme.textFaint)
            }
            .padding(.horizontal, 13).padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Theme.cardRadius)
                .fill(Theme.accent.opacity(0.11)))
            .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius)
                .stroke(Theme.accent.opacity(0.26), lineWidth: 0.5))
        }.buttonStyle(.plain)
    }

    private func groupSection(_ g: GroupP) -> some View {
        let groupKey = g.name.isEmpty ? "Ungrouped" : g.name
        let expanded = expandedWorkspacePreviews.contains(groupKey)
        let visibleCount = WallGroupPreview.visibleCount(
            total: g.cards.count, view: selectedView,
            workspace: selectedWorkspace, expanded: expanded
        )
        let shownCards = Array(g.cards.prefix(visibleCount))
        let canToggle = WallGroupPreview.canToggle(
            total: g.cards.count, view: selectedView, workspace: selectedWorkspace
        )

        return VStack(alignment: .leading, spacing: selectedWorkspace.showsGroupHeadings ? 9 : 0) {
            // In the all-workspaces view this heading identifies which cards
            // belong together. A selected workspace already has that identity
            // in the page title, so repeating it here only creates two titles.
            if selectedWorkspace.showsGroupHeadings {
                HStack(spacing: 8) {
                    Text(groupKey)
                        .font(Theme.fHead)
                        .foregroundColor(g.name.isEmpty ? Theme.cNeeds.opacity(0.82) : Theme.text)
                    Spacer(minLength: 0)
                    if canToggle {
                        QuietButton(label: expanded ? "Show less" : "Show all · \(g.cards.count)") {
                            if expanded {
                                expandedWorkspacePreviews.remove(groupKey)
                            } else {
                                expandedWorkspacePreviews.insert(groupKey)
                            }
                        }
                    }
                }
            }

            // At the two smaller surface sizes, preserve the calm single-column
            // scan. The 90% surface has enough width that one row becomes mostly
            // empty space, so it uses a row-major two-column grid instead.
            LazyVGrid(columns: cardColumns, alignment: .leading, spacing: 8) {
                ForEach(shownCards, id: \.id) { card($0) }
            }
        }
    }

    private var cardColumns: [GridItem] {
        let count = WallCardLayout.columnCount(surfaceFill: Double(model.selectedSurfaceFill))
        return Array(repeating: GridItem(.flexible(), spacing: 8, alignment: .top), count: count)
    }

    // MARK: card

    private func card(_ c: CardP) -> some View {
        Button(action: { model.emit(.focusTask(id: c.id)) }) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Dot(status: c.status, size: 7, breathing: c.status == .processing)
                    StatusLabel(status: c.status)
                    if c.promoted == true { Badge(text: "now a session", color: Theme.accent) }
                    if let origin = c.agentOriginPresentation {
                        Badge(text: origin.label, color: Theme.cReady)
                    } else if c.agent == true {
                        Badge(text: "agent", color: Theme.cReady)
                    }
                    Spacer(minLength: 0)
                    if let q = c.qpos { Badge(text: "Q\(q)") }
                }
                Text(c.title)
                    .font(Theme.fBodyMed).foregroundColor(Theme.text).lineLimit(1)
                if let a = c.activity, !a.isEmpty {
                    Text(a).font(Theme.fSub).foregroundColor(Theme.textDim).lineLimit(2)
                }
                if let n = c.note, !n.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "pencil").font(.system(size: 9.5))
                        Text(n).lineLimit(1)
                    }
                    .font(.system(size: 11.5)).foregroundColor(Theme.cReady)
                }
                // Footer sits at the BOTTOM of the tile, not straight under the
                // body — otherwise a card with no activity line puts its footer
                // halfway up while its neighbour's sits at the base.
                Spacer(minLength: 0)
                HStack(spacing: 6) {
                    // WHO RAN IT, then WHERE. Every card names its backend —
                    // the wall mixes them freely and they do not behave alike.
                    // Model is appended only when it was actually recorded (D6):
                    // an absent model renders the agent alone rather than
                    // inheriting whatever the picker says today.
                    // THE MARK, NOT THE SENTENCE. "Claude Code CLI" is four
                    // words of chrome on a row that already carries a title, a
                    // directory, an age and a model — and it was WRONG for Codex
                    // CLI besides, because the card arrived with no backend and
                    // the label fell through to its default.
                    ProviderMark(backend: c.backend, terminal: c.terminal ?? true)
                    NumText(text: c.kind == "session" ? (c.dir ?? "session") : "one-off")
                    Spacer(minLength: 0)
                    if c.backend == "codex-desktop" {
                        // The grid is the one place we deliberately do NOT show
                        // messages — many tasks at once, so a transcript per card
                        // would drown the wall. The door into the real chat still
                        // belongs here.
                        Button(action: { model.emit(.openInTerminal(id: c.id)) }) {
                            Badge(text: "Open in Codex", color: Theme.cReady)
                        }.buttonStyle(.plain)
                    }
                    NumText(text: c.age ?? "")
                }
                .padding(.top, 2)
            }
            // A UNIFORM TILE, whatever the card happens to carry. The body is
            // optional — a Claude task usually has an activity line, a Codex one
            // often does not — so cards in a row came out different heights and
            // the wall read as ragged. Sized UP to the tallest, never shrinking
            // the ones that have something to say.
            .padding(.horizontal, 12).padding(.vertical, 11)
            .frame(maxWidth: .infinity, minHeight: 104, maxHeight: .infinity, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: Theme.cardRadius).fill(cardFill(c)))
            .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius)
                .stroke(cardStroke(c), lineWidth: 0.5))
        }.buttonStyle(.plain)
    }

    /// A your-move card carries a whisper of its OWN status hue mapped into the
    /// fill — Apple's tinting model, where colour is mapped to the surface
    /// rather than pasted on as a decorative stripe. Our-move and done stay
    /// neutral, so the wall sorts itself visually before you read a word.
    private func cardFill(_ c: CardP) -> Color {
        c.status.isYourMove
            ? Theme.status(c.status).opacity(0.09)
            : Theme.raised
    }
    private func cardStroke(_ c: CardP) -> Color {
        c.status.isYourMove ? Theme.status(c.status).opacity(0.26) : Theme.hairline
    }

    // MARK: sidebar

    private var rail: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Queue — the crank's order.
                railSection("Queue · \(data.queue.count)") {
                    if data.queue.isEmpty {
                        Text("Clear").font(Theme.fSub).foregroundColor(Theme.textFaint)
                    }
                    ForEach(Array(data.queue.enumerated()), id: \.element.id) { i, q in
                        RailRow(action: { model.emit(.focusTask(id: q.id)) }) {
                            NumText(text: "Q\(i + 1)").frame(width: 20, alignment: .leading)
                            Dot(status: q.status, size: 6)
                            Text(q.name).font(Theme.fBody).foregroundColor(Theme.text).lineLimit(1)
                            Spacer(minLength: 0)
                        }
                    }
                }
                // One-offs + clear finished.
                railSection("One-offs · \(data.oneoffs.count)",
                            trailing: ("Clear finished", { model.emit(.clearFinished) })) {
                    if data.oneoffs.isEmpty {
                        Text("Short-lived tasks resolve here")
                            .font(.system(size: 11.5)).foregroundColor(Theme.textFaint)
                    }
                    ForEach(data.oneoffs, id: \.id) { o in
                        RailRow(action: { model.emit(.focusTask(id: o.id)) }) {
                            Dot(status: o.status, size: 6)
                            Text(o.name).font(Theme.fBody).foregroundColor(Theme.text).lineLimit(1)
                            Spacer(minLength: 0)
                            NumText(text: o.age ?? "")
                        }
                    }
                }
                // PROJECTS and SUGGESTIONS were here and are gone.
                //
                // Projects listed directories with no action attached — you
                // could not do anything with one from the rail. Suggestions was
                // the curator's review inbox, and the curator is parked
                // (CURATOR_PARKED, remote/init.ts), so it can never receive
                // anything again. An inbox that cannot fill reads as broken.
                //
                // The rail is now four sections that can each be acted on:
                // Queue, One-offs, Skills, Shelf.
                // Skills: curator-authored first, then the vocabulary.
                if !data.unmuteSkills.isEmpty {
                    railSection("Unmute skills") {
                        ForEach(data.unmuteSkills, id: \.name) { skillRow($0) }
                    }
                }
                if !data.skills.isEmpty {
                    railSection("Skills") {
                        ForEach(model.skillsExpanded ? data.skills : Array(data.skills.prefix(6)),
                                id: \.name) { skillRow($0) }
                        if data.skills.count > 6 {
                            QuietButton(label: model.skillsExpanded
                                        ? "Show less" : "\(data.skills.count - 6) more…") {
                                model.skillsExpanded.toggle()
                            }
                        }
                    }
                }
                // IMPORT A CLI SESSION — the rail.
                //
                // Sessions this machine already has and unmute does not: threads
                // you started in your own terminal, in either CLI. Adopting one
                // puts it on the wall with its history and starts nothing.
                //
                // GROUPED BY BACKEND, which reverses the original call. The rail
                // interleaved both CLIs by recency on the reasoning that "you do
                // not think of it per-backend" — but it did that under a heading
                // that said "Other Claude Code sessions", so Codex threads were
                // listed under Claude's name. Once each row has to say which CLI
                // it is anyway, a group header carries that once instead of every
                // row repeating it.
                //
                // CAPPED, because this list is long. Forty sessions pushed the
                // shelf and everything under it off the bottom of the rail; three
                // per backend answers "is there anything to bring in" and the rest
                // is one tap away.
                if let rows = data.importable, !rows.isEmpty {
                    importRail(rows)
                }
                // Shelf.
                if !data.shelf.isEmpty {
                    railSection("Shelf · \(data.shelf.count)") {
                        ForEach(data.shelf, id: \.id) { s in
                            HStack(spacing: 8) {
                                Button(action: { model.emit(.focusTask(id: s.id)) }) {
                                    Text(s.name).font(Theme.fBody)
                                        .foregroundColor(Theme.text).lineLimit(1)
                                }.buttonStyle(.plain)
                                Spacer(minLength: 0)
                                Button(action: { model.emit(.shelve(id: s.id, shelved: false)) }) {
                                    Image(systemName: "chevron.up")
                                        .font(.system(size: 10, weight: .semibold))
                                        .foregroundColor(Theme.textFaint)
                                }.buttonStyle(.plain).help("Unshelve — back on the wall")
                            }
                            .padding(.horizontal, 8).padding(.vertical, 4)
                        }
                    }
                }
                Spacer(minLength: 44)
            }
            .padding(.horizontal, 14)
            .padding(.top, topInset)
        }
        .scrollEdge(topInset + 14)
        .frame(width: 250)
        .background(Theme.railBg)
        .overlay(Rectangle().fill(Theme.hairlineSoft).frame(width: 1), alignment: .leading)
    }

    /// WHO ran this card, and on what.
    ///
    /// Mirrors providers.ts's labels — the Swift side cannot import the
    /// registry, so this is the one place a backend id becomes a human name.
    /// Absent backend means the PTY default, which is Claude Code CLI: cards
    /// have always been persisted with no agent key, so absent is a contract
    /// rather than a gap.
    ///
    /// The model is appended ONLY when one was recorded (D6). An absent model
    /// renders the agent alone — never "unknown", never the current picker
    /// value, because a task that ran under Sonnet must not claim Opus just
    /// because the picker moved since it finished.
    private func agentLabel(_ c: CardP) -> String {
        let agent: String
        switch c.backend {
        case "codex-desktop":       agent = "Codex desktop"
        case "claude-code-desktop": agent = "Claude desktop"
        case "codex":               agent = "Codex CLI"
        default:                    agent = "Claude Code CLI"
        }
        guard let m = c.model, !m.isEmpty else { return agent }
        return "\(agent) · \(m)"
    }

    private func suggestionColor(_ kind: String) -> Color {
        switch kind {
        case "retire": return Theme.cError
        case "create": return Theme.cWorking
        default:       return Theme.cNeeds
        }
    }


    /// How many rows of each backend show before the expander.
    private static let importPreview = 3

    /// The import rail: one heading, a group per CLI, each capped until asked.
    @ViewBuilder private func importRail(_ rows: [ImportableP]) -> some View {
        let groups: [(String, [ImportableP])] = [
            ("claude", rows.filter { ($0.agent ?? "claude") == "claude" }),
            ("codex",  rows.filter { $0.agent == "codex" }),
        ].filter { !$0.1.isEmpty }

        VStack(alignment: .leading, spacing: 4) {
            // THE WHOLE HEADING IS THE TOGGLE. A caret alone is a small target
            // on a dense rail, and this section is the one a user collapses
            // permanently once they have imported what they wanted.
            Button(action: { importOpen.toggle() }) {
                HStack(spacing: 6) {
                    SectionLabel(text: "Import a CLI session · \(rows.count)")
                    Image(systemName: importOpen ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundColor(Theme.textFaint)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Sessions already on this Mac that unmute doesn't know about — started in Claude Code or Codex in your own terminal. Importing brings one onto the wall with its history; nothing is started.")
            .padding(.bottom, 3)

            if importOpen {
                ForEach(groups, id: \.0) { backend, all in
                    let expanded = importExpanded.contains(backend)
                    let shown = expanded ? all : Array(all.prefix(Self.importPreview))
                    // The backend's own mark, so the group says which CLI without
                    // spending a word on it.
                    HStack(spacing: 6) {
                        ProviderMark(backend: backend, terminal: true)
                        Text(backend == "codex" ? "Codex CLI" : "Claude Code CLI")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(Theme.textFaint)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 8).padding(.top, 4)

                    ForEach(shown, id: \.sessionId) { r in importRow(r) }

                    if all.count > Self.importPreview {
                        Button(action: {
                            if expanded { importExpanded.remove(backend) } else { importExpanded.insert(backend) }
                        }) {
                            Text(expanded
                                 ? "Show fewer"
                                 : "\(all.count - Self.importPreview) more")
                                .font(.system(size: 10.5, weight: .medium))
                                .foregroundColor(Theme.textDim)
                        }
                        .buttonStyle(.plain)
                        .padding(.horizontal, 8).padding(.bottom, 2)
                    }
                }
            }
        }
    }

    private func importRow(_ r: ImportableP) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(r.title).font(Theme.fBody)
                    .foregroundColor(Theme.text).lineLimit(1)
                Text("\(r.project) · \(r.age)")
                    .font(.system(size: 10))
                    .foregroundColor(Theme.textFaint).lineLimit(1)
            }
            Spacer(minLength: 0)
            // Confirms before adopting. Import is cheap and reversible, but it
            // puts a card on the wall that was not there a second ago, and a
            // list you scroll should not act on a stray click.
            Button(action: { confirmImport = r }) {
                Text("Import")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundColor(Theme.textDim)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Theme.raised))
                    .overlay(RoundedRectangle(cornerRadius: 6)
                        .stroke(Theme.hairline, lineWidth: 0.5))
            }
            .buttonStyle(.plain)
            .help("Bring this session onto the wall — it keeps its history and starts nothing")
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
    }

    private func railSection<Content: View>(_ title: String,
                                            trailing: (String, () -> Void)? = nil,
                                            @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                SectionLabel(text: title)
                Spacer(minLength: 0)
                if let (label, action) = trailing {
                    QuietButton(label: label, color: Theme.textFaint, action: action)
                }
            }
            .padding(.bottom, 3)
            content()
        }
    }

    private func skillRow(_ s: SkillP) -> some View {
        HStack(spacing: 7) {
            Button(action: { model.emit(.pinSkill(name: s.name, pinned: !s.pinned)) }) {
                Image(systemName: s.pinned ? "star.fill" : "star")
                    .font(.system(size: 10.5))
                    .foregroundColor(s.pinned ? Theme.pinGold : Theme.textFaint)
            }
            .buttonStyle(.plain)
            .help(s.pinned ? "Unpin" : "Pin — rank first")

            Text(s.name).font(Theme.fBody).foregroundColor(Theme.text).lineLimit(1)
            if s.origin == "unmute" { Badge(text: "unmute", color: Theme.cReady) }
            Spacer(minLength: 0)
            NumText(text: s.runs > 0 ? "\(s.runs)×" : (s.lastUsed ?? ""))
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .contentShape(Rectangle())
        // Capture the row's window-space frame so the detail card can anchor
        // BESIDE it (field feedback: it must never float at a far corner).
        .background(GeometryReader { geo in
            Color.clear.onChange(of: model.hoverSkill?.name) { hovered in
                if hovered == s.name { model.hoverSkillFrame = geo.frame(in: .global) }
            }
        })
        .onHover { over in model.hoverSkill = over ? s : nil }
        // Tap-to-invoke: types `/name ` unsubmitted into the focused, live task.
        .onTapGesture { model.emit(.tapSkill(name: s.name)) }
        .help("Say its name to use it · tap to type /\(s.name) into the focused task")
    }

    // MARK: floating chrome

    /// One bottom bar over the wall: the live voice chip, then the route offer
    /// and the doorbell pushed to the right. A single row means nothing can
    /// overlap anything else however many pieces are present.
    private var bottomChrome: some View {
        HStack(alignment: .bottom, spacing: 8) {
            bottomLeftChrome
            Spacer(minLength: 12)
            bottomRightChrome
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.bottom, 12)
    }

    private var bottomLeftChrome: some View {
        HStack(spacing: 8) {
            voiceChip
        }
    }

    private var voiceChip: some View {
        HStack(spacing: 7) {
            Image(systemName: model.capturePhase == nil ? "mic" : "mic.fill")
                .font(.system(size: 11))
            Text(voiceChipText).font(Theme.fSub)
        }
        .foregroundColor(model.capturePhase != nil ? Theme.cWorking : Theme.textDim)
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(Capsule().fill(model.capturePhase != nil
                                   ? Theme.cWorking.opacity(0.14) : Theme.raised))
        .overlay(Capsule().stroke(model.capturePhase != nil
                                  ? Theme.cWorking.opacity(0.30) : Theme.hairline, lineWidth: 0.5))
        .animation(Theme.hover, value: model.capturePhase)
    }

    private var voiceChipText: String {
        if let phase = model.capturePhase {
            let target = model.captureTarget ?? "new task"
            switch phase {
            case "listening": return "Listening → \(target)"
            case "transcribing", "routing": return "\(phase.capitalized)…"
            case "landed": return "Landed → \(target)"
            default: break
            }
        }
        if let f = model.focusedId, let name = model.stageTask?.title, model.stageTask?.id == f {
            return "Voice → \(name)"
        }
        return "Voice → new task"
    }

    private var bottomRightChrome: some View {
        HStack(spacing: 8) {
            SurfaceSizeControls(model: model)
            if let offer = data.routeOffer {
                Button(action: { model.emit(.offerAccept(newTaskId: offer.newTaskId)) }) {
                    Text("Started new — send to “\(offer.altName)” instead?")
                        .font(Theme.fSub).foregroundColor(Theme.cNeeds)
                        .lineLimit(1)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(Capsule().fill(Theme.raised))
                        .overlay(Capsule().stroke(Theme.hairline, lineWidth: 0.5))
                }.buttonStyle(.plain)
            }
            Button(action: { model.emit(.bellToggle) }) {
                Image(systemName: data.doorbell ? "bell" : "bell.slash")
                    .font(.system(size: 12.5))
                    .foregroundColor(data.doorbell ? Theme.text : Theme.textFaint)
                    .frame(width: 30, height: 30)
                    .background(Circle().fill(Theme.raised))
                    .overlay(Circle().stroke(Theme.hairline, lineWidth: 0.5))
            }
            .buttonStyle(.plain)
            .help("Doorbell — spoken headlines when a task needs you")
        }
    }

    // MARK: skill hover card

    @ViewBuilder private var hoverCard: some View {
        if let s = model.hoverSkill {
            let cardW: CGFloat = 280
            let f = model.hoverSkillFrame
            // Anchor beside the hovered row: to its LEFT (the rail hugs the right
            // edge), vertically aligned with the row; clamped on-surface.
            let x = max(8, f.minX - cardW - 12)
            let y = max(topInset, f.minY - 10)
            VStack(alignment: .leading, spacing: 5) {
                Text(s.name).font(Theme.fBodyMed).foregroundColor(Theme.text)
                Text((s.description?.isEmpty == false) ? s.description!
                     : "No description in this skill's frontmatter.")
                    .font(Theme.fSub).foregroundColor(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                NumText(text: "Last used \(s.lastUsed ?? "—") · say its name to use it")
            }
            .padding(12)
            .frame(width: cardW, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color(red: 0.10, green: 0.11, blue: 0.13)))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.hairline, lineWidth: 0.5))
            .shadow(color: .black.opacity(0.5), radius: 20, y: 8)
            .offset(x: x, y: y)
            .allowsHitTesting(false)
        }
    }
}

/// A sidebar row with a hover surface, so it reads as a target before you touch
/// it. Rows are 6pt-radius rather than square — dense controls stay rounded
/// rectangles on macOS.
struct RailRow<Content: View>: View {
    let action: () -> Void
    @ViewBuilder let content: () -> Content
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) { content() }
                .padding(.horizontal, 8).padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .background(RoundedRectangle(cornerRadius: 6)
                    .fill(hovering ? Theme.raised : Color.clear))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Theme.hover, value: hovering)
    }
}
