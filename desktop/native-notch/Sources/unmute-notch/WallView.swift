import SwiftUI

// The cockpit wall — full parity with the React OrchestrateWall (resting mode):
// group sections of cards, the right rail (queue / one-offs / projects /
// suggestions / skills / shelf), the away digest, doorbell, staged-tray chip,
// and the route offer. Clicking a card emits focusTask (voice address) and the
// Stage takes over (StageView).
struct WallView: View {
    @ObservedObject var model: NotchModel
    let topInset: CGFloat

    private var data: CockpitData {
        model.cockpit ?? CockpitData(groups: [], queue: [], oneoffs: [], projects: [],
                                     suggestions: [], unmuteSkills: [], skills: [], shelf: [],
                                     digest: nil, stagedCount: 0, doorbell: true,
                                     routeOffer: nil, tmuxAvailable: false)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            main
            rail
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(alignment: .bottomLeading) { bottomLeftChrome }
        .overlay(alignment: .bottomTrailing) { bottomRightChrome }
        .overlay(alignment: .topLeading) { hoverCard }
    }

    // MARK: main column

    private var main: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("UNMUTE · COCKPIT")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .tracking(1.6).foregroundColor(Theme.textFaint)

                if let digest = data.digest {
                    Button(action: { model.emit(.digestDismiss) }) {
                        Text(digest)
                            .font(.system(size: 12.5)).foregroundColor(Color(red: 0.75, green: 0.88, blue: 0.96))
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Color(red: 0.36, green: 0.71, blue: 0.91).opacity(0.08)))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(red: 0.36, green: 0.71, blue: 0.91).opacity(0.2), lineWidth: 1))
                    }.buttonStyle(.plain)
                }

                if data.groups.allSatisfy({ $0.cards.isEmpty }) {
                    Text("no sessions — speak to spawn one")
                        .font(.system(size: 13)).foregroundColor(Theme.textFaint)
                        .padding(.top, 30).frame(maxWidth: .infinity, alignment: .center)
                }

                ForEach(Array(data.groups.enumerated()), id: \.offset) { _, group in
                    if !group.cards.isEmpty { groupSection(group) }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, topInset)
            .padding(.bottom, 56)
        }
    }

    private func groupSection(_ g: GroupP) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            if !g.name.isEmpty {
                HStack(spacing: 8) {
                    Text(g.name).font(.system(size: 14, weight: .semibold)).foregroundColor(Theme.text)
                    Badge(text: "group")
                }
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 236), spacing: 10)], alignment: .leading, spacing: 10) {
                ForEach(g.cards, id: \.id) { card($0) }
            }
        }
    }

    private func card(_ c: CardP) -> some View {
        Button(action: { model.emit(.focusTask(id: c.id)) }) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Dot(status: c.status, size: 7)
                    Text(Theme.statusLabel(c.status).uppercased())
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .tracking(0.5).foregroundColor(Theme.status(c.status))
                    if c.promoted == true { Badge(text: "↑ now a session", color: Color(red: 0.36, green: 0.71, blue: 0.91)) }
                    if c.agent == true { Badge(text: "↳ agent", color: Theme.cReady) }
                    Spacer(minLength: 0)
                    if let q = c.qpos { Badge(text: "Q\(q)", color: Theme.textDim) }
                }
                Text(c.title).font(.system(size: 14, weight: .medium)).foregroundColor(Theme.text).lineLimit(1)
                if let a = c.activity, !a.isEmpty {
                    Text(a).font(.system(size: 12)).foregroundColor(Theme.textDim).lineLimit(2)
                }
                if let n = c.note, !n.isEmpty {
                    Text("✎ \(n)").font(.system(size: 11.5)).foregroundColor(Theme.cReady).lineLimit(1)
                }
                HStack(spacing: 6) {
                    Text(c.kind == "session" ? (c.dir ?? "session") : "one-off")
                    Spacer(minLength: 0)
                    if c.backend == "codex-desktop" {
                        // The grid is the one place we deliberately do NOT show
                        // messages — many tasks at once, so a transcript per
                        // card would drown the wall. The door into the real
                        // chat still belongs here.
                        Button(action: { model.emit(.openInTerminal(id: c.id)) }) {
                            Text("open in Codex")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundColor(Theme.cReady)
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(RoundedRectangle(cornerRadius: 5).fill(Theme.cReady.opacity(0.12)))
                        }.buttonStyle(.plain)
                    }
                    Text(c.age ?? "")
                }
                .font(.system(size: 10.5, design: .monospaced)).foregroundColor(Theme.textFaint)
                .padding(.top, 3)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.cardBg))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.hairline, lineWidth: 1))
        }.buttonStyle(.plain)
    }

    // MARK: rail

    private var rail: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Queue — the crank's order.
                railSection("QUEUE · \(data.queue.count)") {
                    if data.queue.isEmpty {
                        Text("clear").font(.system(size: 12)).foregroundColor(Theme.textFaint)
                    }
                    ForEach(Array(data.queue.enumerated()), id: \.element.id) { i, q in
                        Button(action: { model.emit(.focusTask(id: q.id)) }) {
                            HStack(spacing: 8) {
                                Text("Q\(i + 1)").font(.system(size: 10.5, design: .monospaced)).foregroundColor(Theme.textFaint).frame(width: 22, alignment: .leading)
                                Dot(status: q.status, size: 6)
                                Text(q.name).font(.system(size: 13)).foregroundColor(Theme.text).lineLimit(1)
                            }
                        }.buttonStyle(.plain)
                    }
                }
                // One-offs + clear finished.
                railSection("ONE-OFFS · \(data.oneoffs.count)", trailing: ("clear finished", { model.emit(.clearFinished) })) {
                    if data.oneoffs.isEmpty {
                        Text("short-lived tasks resolve here").font(.system(size: 11.5)).foregroundColor(Theme.textFaint)
                    }
                    ForEach(data.oneoffs, id: \.id) { o in
                        Button(action: { model.emit(.focusTask(id: o.id)) }) {
                            HStack(spacing: 8) {
                                Dot(status: o.status, size: 6)
                                Text(o.name).font(.system(size: 13)).foregroundColor(Theme.text).lineLimit(1)
                                Spacer(minLength: 0)
                                Text(o.age ?? "").font(.system(size: 10.5, design: .monospaced)).foregroundColor(Theme.textFaint)
                            }
                        }.buttonStyle(.plain)
                    }
                }
                // Projects.
                if !data.projects.isEmpty {
                    railSection("PROJECTS") {
                        ForEach(data.projects, id: \.path) { p in
                            Button(action: { model.emit(.openProject(path: p.path, name: p.name)) }) {
                                Text("▸ \(p.name)").font(.system(size: 13)).foregroundColor(Theme.textDim).lineLimit(1)
                            }.buttonStyle(.plain)
                        }
                    }
                }
                // Curator suggestions → review popup.
                if !data.suggestions.isEmpty {
                    railSection("SUGGESTIONS · \(data.suggestions.count)") {
                        ForEach(data.suggestions, id: \.id) { s in
                            Button(action: { model.proposalLoadingId = s.id; model.emit(.suggestionOpen(id: s.id)) }) {
                                HStack(spacing: 7) {
                                    Text(s.kind).font(.system(size: 9, weight: .bold, design: .monospaced)).foregroundColor(Theme.accent)
                                    Text(s.name).font(.system(size: 13)).foregroundColor(Theme.text).lineLimit(1)
                                }
                            }.buttonStyle(.plain)
                        }
                    }
                }
                // Skills: curator-authored first, then the vocabulary (top-6 + expander).
                if !data.unmuteSkills.isEmpty {
                    railSection("UNMUTE SKILLS") {
                        ForEach(data.unmuteSkills, id: \.name) { skillRow($0) }
                    }
                }
                if !data.skills.isEmpty {
                    railSection("SKILLS") {
                        ForEach(model.skillsExpanded ? data.skills : Array(data.skills.prefix(6)), id: \.name) { skillRow($0) }
                        if data.skills.count > 6 {
                            Button(action: { model.skillsExpanded.toggle() }) {
                                Text(model.skillsExpanded ? "· show less" : "· \(data.skills.count - 6) more…")
                                    .font(.system(size: 12)).foregroundColor(Theme.textFaint)
                            }.buttonStyle(.plain)
                        }
                    }
                }
                // Shelf.
                if !data.shelf.isEmpty {
                    railSection("SHELF · \(data.shelf.count)") {
                        ForEach(data.shelf, id: \.id) { s in
                            HStack(spacing: 8) {
                                Button(action: { model.emit(.focusTask(id: s.id)) }) {
                                    Text(s.name).font(.system(size: 13)).foregroundColor(Theme.text).lineLimit(1)
                                }.buttonStyle(.plain)
                                Spacer(minLength: 0)
                                Button(action: { model.emit(.shelve(id: s.id, shelved: false)) }) {
                                    Text("⌃").font(.system(size: 12)).foregroundColor(Theme.textFaint)
                                }.buttonStyle(.plain).help("unshelve — back on the wall")
                            }
                        }
                    }
                }
                Spacer(minLength: 40)
            }
            .padding(.horizontal, 16)
            .padding(.top, topInset)
        }
        .frame(width: 300)
        .background(Theme.railBg)
        .overlay(Rectangle().fill(Theme.hairline).frame(width: 1), alignment: .leading)
    }

    private func railSection<Content: View>(_ title: String,
                                            trailing: (String, () -> Void)? = nil,
                                            @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(title).font(.system(size: 10.5, weight: .medium, design: .monospaced))
                    .tracking(1.2).foregroundColor(Theme.textFaint)
                Spacer(minLength: 0)
                if let (label, action) = trailing {
                    Button(action: action) {
                        Text(label).font(.system(size: 10, design: .monospaced)).foregroundColor(Theme.textDim)
                    }.buttonStyle(.plain)
                }
            }
            content()
        }
    }

    private func skillRow(_ s: SkillP) -> some View {
        HStack(spacing: 7) {
            Button(action: { model.emit(.pinSkill(name: s.name, pinned: !s.pinned)) }) {
                Text(s.pinned ? "★" : "☆")
                    .font(.system(size: 12))
                    .foregroundColor(s.pinned ? Theme.pinGold : Theme.textFaint)
            }.buttonStyle(.plain).help(s.pinned ? "unpin" : "pin — rank first")
            Text(s.name).font(.system(size: 13)).foregroundColor(Theme.text).lineLimit(1)
            if s.origin == "unmute" { Badge(text: "unmute", color: Theme.cReady) }
            Spacer(minLength: 0)
            Text(s.runs > 0 ? "\(s.runs)×" : (s.lastUsed ?? ""))
                .font(.system(size: 10.5, design: .monospaced)).foregroundColor(Theme.textFaint)
        }
        .contentShape(Rectangle())
        // Capture the row's window-space frame so the detail card can anchor
        // BESIDE it (field feedback: it must never float at a far corner).
        .background(GeometryReader { geo in
            Color.clear.onChange(of: model.hoverSkill?.name) { hovered in
                if hovered == s.name { model.hoverSkillFrame = geo.frame(in: .global) }
            }
        })
        .onHover { over in
            model.hoverSkill = over ? s : nil
        }
        // Tap-to-invoke: types `/name ` unsubmitted into the focused, live task.
        .onTapGesture { model.emit(.tapSkill(name: s.name)) }
        .help("say its name to use it · tap to type /\(s.name) into the focused task")
    }

    // MARK: floating chrome

    private var bottomLeftChrome: some View {
        HStack(spacing: 10) {
            if data.stagedCount > 0 {
                HStack(spacing: 8) {
                    Text("🖼 \(data.stagedCount) staged — speaks with your next task")
                        .font(.system(size: 11.5)).foregroundColor(Theme.textDim)
                    Button(action: { model.emit(.clearStaged) }) {
                        Text("✕").font(.system(size: 11)).foregroundColor(Theme.textFaint)
                    }.buttonStyle(.plain)
                }
                .padding(.horizontal, 11).padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 9).fill(Color.black.opacity(0.4)))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(Theme.hairline, lineWidth: 1))
            }
            voiceChip
        }.padding(14)
    }

    private var voiceChip: some View {
        HStack(spacing: 7) {
            Image(systemName: "mic.fill").font(.system(size: 10)).foregroundColor(Theme.textDim)
            Text(voiceChipText).font(.system(size: 12)).foregroundColor(model.capturePhase != nil ? Theme.cWorking : Theme.textDim)
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 9).fill(Color.black.opacity(0.35)))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(Theme.hairline, lineWidth: 1))
    }
    private var voiceChipText: String {
        if let phase = model.capturePhase {
            let target = model.captureTarget ?? "new task"
            switch phase {
            case "listening": return "listening → \(target)"
            case "transcribing", "routing": return "\(phase)…"
            case "landed": return "landed → \(target)"
            default: break
            }
        }
        if let f = model.focusedId, let name = model.stageTask?.title, model.stageTask?.id == f {
            return "voice → \(name)"
        }
        return "voice → new task"
    }

    private var bottomRightChrome: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if let offer = data.routeOffer {
                Button(action: { model.emit(.offerAccept(newTaskId: offer.newTaskId)) }) {
                    Text("started new — send to “\(offer.altName)” instead?")
                        .font(.system(size: 12)).foregroundColor(Color(red: 0.94, green: 0.83, blue: 0.60))
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 9).fill(Theme.accent.opacity(0.12)))
                        .overlay(RoundedRectangle(cornerRadius: 9).stroke(Theme.accentDim, lineWidth: 1))
                }.buttonStyle(.plain)
            }
            Button(action: { model.emit(.bellToggle) }) {
                Text(data.doorbell ? "🔔" : "🔕").font(.system(size: 17))
            }.buttonStyle(.plain).help("doorbell — spoken headlines when a task needs you")
        }.padding(14)
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
                Text(s.name).font(.system(size: 13, weight: .semibold)).foregroundColor(Theme.text)
                Text((s.description?.isEmpty == false) ? s.description! : "No description in this skill's frontmatter.")
                    .font(.system(size: 12)).foregroundColor(Theme.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                Text("last used \(s.lastUsed ?? "—") · say its name to use it")
                    .font(.system(size: 10.5, design: .monospaced)).foregroundColor(Theme.textFaint)
            }
            .padding(12)
            .frame(width: cardW, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color(white: 0.07)))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.15), lineWidth: 1))
            .shadow(color: .black.opacity(0.5), radius: 18, y: 8)
            .offset(x: x, y: y)
            .allowsHitTesting(false)
        }
    }
}
