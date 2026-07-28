import SwiftUI

// The cockpit wall — group sections of cards plus the sidebar (queue / one-offs
// / projects / suggestions / skills / shelf), the away digest, doorbell,
// staged-tray chip and the route offer. Clicking a card emits focusTask (the
// voice address) and the Stage takes over (StageView).
//
// GOLDEN GATE: the sidebar is EDGE-TO-EDGE, not an inset floating pane — Tahoe's
// floating sidebar was removed in the 27 design. Both scrollers carry a hard
// scroll-edge effect so content dissolves under the pinned chrome rather than
// colliding with it.
struct WallView: View {
    @ObservedObject var model: NotchModel
    let topInset: CGFloat

    private var data: CockpitData {
        model.cockpit ?? CockpitData(groups: [], hiddenTotal: 0, showingAll: false,
                                     queue: [], oneoffs: [], projects: [],
                                     suggestions: [], unmuteSkills: [], skills: [], shelf: [],
                                     digest: nil, stagedCount: 0, doorbell: true,
                                     routeOffer: nil, tmuxAvailable: false)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            // THE FLOATING CHROME BELONGS TO THE MAIN COLUMN, NOT THE SURFACE.
            //
            // Overlaying it on the whole HStack floated the route offer and the
            // doorbell across the sidebar, where they landed on top of the
            // skills list and each other. Scoping the overlay to `main` keeps
            // them over the wall — which is what they describe — and leaves the
            // rail's own rows reachable all the way down.
            main
                .overlay(alignment: .bottom) { bottomChrome }
            rail
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(alignment: .topLeading) { hoverCard }
    }

    // MARK: main column

    private var main: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header

                if let digest = data.digest { digestBanner(digest) }

                // "Nothing here" means nothing EXISTS — not "everything is
                // folded", which is a different thing with a way out.
                if data.groups.allSatisfy({ $0.cards.isEmpty }) && (data.hiddenTotal ?? 0) == 0 {
                    Text("No sessions — speak to spawn one")
                        .font(Theme.fBody).foregroundColor(Theme.textFaint)
                        .padding(.top, 34).frame(maxWidth: .infinity, alignment: .center)
                }

                // A GROUP KEEPS ITS HEADER WHEN EVERYTHING IN IT IS FOLDED.
                // Skipping empty groups silently deleted whole groups from the
                // wall once folding arrived, taking their "show all" with them
                // and making those tasks unreachable by any gesture.
                ForEach(Array(data.groups.enumerated()), id: \.offset) { _, group in
                    if !group.cards.isEmpty || (group.hidden ?? 0) > 0 { groupSection(group) }
                }
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.top, topInset + 4)
            .padding(.bottom, 60)
        }
        .scrollEdge(topInset + 18)
    }

    private var header: some View {
        HStack(spacing: 10) {
            SectionLabel(text: "Cockpit")
            Spacer(minLength: 0)
            // The wall-level way back. Deliberately not dependent on any group
            // rendering its own header — that dependency is what made folded
            // work unreachable.
            if data.showingAll == true {
                QuietButton(label: "Hide older everywhere") {
                    model.emit(.showAll(group: nil, on: false))
                }
            } else if let n = data.hiddenTotal, n > 0 {
                QuietButton(label: "Show all · \(n) older", color: Theme.cReady) {
                    model.emit(.showAll(group: nil, on: true))
                }
            }
            CloseButton { model.emit(.collapsed) }
        }
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
        VStack(alignment: .leading, spacing: 9) {
            // ALWAYS a heading, including for the ungrouped bucket. Without one
            // its cards rendered under the previous group's title — so the
            // newest task looked like it belonged to someone else's group and a
            // correctly-sorted wall looked scrambled.
            HStack(spacing: 8) {
                Text(g.name.isEmpty ? "Ungrouped" : g.name)
                    .font(Theme.fHead)
                    .foregroundColor(g.name.isEmpty ? Theme.textDim : Theme.text)
                if !g.name.isEmpty { Badge(text: "group") }
                // SAY that cards are folded away — a group silently missing half
                // its tasks reads as a group that lost them. Acts on THIS group:
                // a control in a group header that expanded the whole wall, and
                // then offered no way to collapse, was the complaint.
                if g.expanded == true {
                    QuietButton(label: "Show less") { model.emit(.showAll(group: g.name, on: false)) }
                } else if let n = g.hidden, n > 0 {
                    QuietButton(label: "Show all · \(n)", color: Theme.cReady) {
                        model.emit(.showAll(group: g.name, on: true))
                    }
                }
                Spacer(minLength: 0)
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 224), spacing: 8)],
                      alignment: .leading, spacing: 8) {
                ForEach(g.cards, id: \.id) { card($0) }
            }
        }
    }

    // MARK: card

    private func card(_ c: CardP) -> some View {
        Button(action: { model.emit(.focusTask(id: c.id)) }) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Dot(status: c.status, size: 7, breathing: c.status == .processing)
                    StatusLabel(status: c.status)
                    if c.promoted == true { Badge(text: "now a session", color: Theme.accent) }
                    if c.agent == true { Badge(text: "agent", color: Theme.cReady) }
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
                // Projects.
                if !data.projects.isEmpty {
                    railSection("Projects") {
                        ForEach(data.projects, id: \.path) { p in
                            RailRow(action: { model.emit(.openProject(path: p.path, name: p.name)) }) {
                                Image(systemName: "folder")
                                    .font(.system(size: 11)).foregroundColor(Theme.textFaint)
                                Text(p.name).font(Theme.fBody).foregroundColor(Theme.textDim).lineLimit(1)
                                Spacer(minLength: 0)
                            }
                        }
                    }
                }
                // Curator suggestions → review popup.
                if !data.suggestions.isEmpty {
                    railSection("Suggestions · \(data.suggestions.count)") {
                        ForEach(data.suggestions, id: \.id) { s in
                            RailRow(action: {
                                model.proposalLoadingId = s.id
                                model.emit(.suggestionOpen(id: s.id))
                            }) {
                                Badge(text: s.kind, color: suggestionColor(s.kind))
                                Text(s.name).font(Theme.fBody).foregroundColor(Theme.text).lineLimit(1)
                                Spacer(minLength: 0)
                            }
                        }
                    }
                }
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

    private func suggestionColor(_ kind: String) -> Color {
        switch kind {
        case "retire": return Theme.cError
        case "create": return Theme.cWorking
        default:       return Theme.cNeeds
        }
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

    /// One bottom bar over the wall: staged tray, the live voice chip, then the
    /// route offer and the doorbell pushed to the right. A single row means
    /// nothing can overlap anything else however many pieces are present.
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
            if data.stagedCount > 0 {
                HStack(spacing: 7) {
                    Image(systemName: "photo.on.rectangle")
                        .font(.system(size: 11)).foregroundColor(Theme.textDim)
                    Text("\(data.stagedCount) staged — speaks with your next task")
                        .font(.system(size: 11.5)).foregroundColor(Theme.textDim)
                    Button(action: { model.emit(.clearStaged) }) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 11)).foregroundColor(Theme.textFaint)
                    }.buttonStyle(.plain)
                }
                .padding(.horizontal, 11).padding(.vertical, 7)
                .background(Capsule().fill(Theme.raised))
                .overlay(Capsule().stroke(Theme.hairline, lineWidth: 0.5))
            }
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
            if let offer = data.routeOffer {
                Button(action: { model.emit(.offerAccept(newTaskId: offer.newTaskId)) }) {
                    Text("Started new — send to “\(offer.altName)” instead?")
                        .font(Theme.fSub).foregroundColor(Theme.cNeeds)
                        .lineLimit(1)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(Capsule().fill(Theme.cNeeds.opacity(0.14)))
                        .overlay(Capsule().stroke(Theme.cNeeds.opacity(0.30), lineWidth: 0.5))
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
