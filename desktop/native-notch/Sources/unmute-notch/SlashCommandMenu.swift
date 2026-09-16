import SwiftUI
import AppKit
import ComposerSupport

// The wire type IS the model — see SlashCommandItem. Declared here rather than
// in IPC.swift so that file keeps its four imports and the Checks harness does
// not have to link another module to compile the decoders.
extension CommandP: SlashCommandItem {}

/// The keys the composer's menu claims before the text view acts on them.
enum ComposerKeyCommand { case up, down, accept, cancel }

/// The composer's slash-menu state, one per card.
///
/// An ObservableObject rather than plain @State for one reason: Escape never
/// reaches the text view. AppController's local key monitor swallows keyCode 53
/// app-wide (it steps the surface down), so the menu has to be closable from
/// outside the view hierarchy — hence the static registration below.
final class SlashMenuState: ObservableObject {
    @Published private(set) var isOpen = false
    @Published private(set) var matches: [CommandP] = []
    @Published private(set) var selection = 0

    /// Escape closed the menu; the same draft must not spring it back open on
    /// the next keystroke. The veto expires when the draft stops being a bare
    /// command, so typing a fresh `/` always works.
    private var dismissed = false

    /// THE one menu Escape can reach. Only an open menu registers, and a menu
    /// can only open in the focused composer, so there is never a contest.
    /// Weak: a card switch destroys the composer and this clears itself.
    private static weak var presented: SlashMenuState?

    /// Escape belongs to the menu while it is open — it closes the menu and
    /// leaves the card where it is. Returns false when no menu is open, which
    /// is the fast path for every other Escape in the app.
    static func closePresented() -> Bool {
        guard let menu = presented else { return false }
        menu.dismiss()
        return true
    }

    /// Recompute from the draft. Called on every edit, so it must stay cheap
    /// and must not publish when nothing changed.
    func refresh(draft: String, commands: [CommandP]) {
        guard !commands.isEmpty, let query = SlashCommands.query(for: draft) else {
            dismissed = false
            close()
            return
        }
        guard !dismissed else { return }
        let next = SlashCommands.filter(commands, query: query)
        if next.map(\.token) != matches.map(\.token) { matches = next }
        let clamped = SlashCommands.clamp(selection: selection, count: next.count)
        if clamped != selection { selection = clamped }
        if !isOpen {
            isOpen = true
            Self.presented = self
        }
    }

    func close() {
        if Self.presented === self { Self.presented = nil }
        guard isOpen || !matches.isEmpty else { return }
        isOpen = false
        matches = []
        selection = 0
    }

    private func dismiss() {
        dismissed = true
        close()
    }

    func select(_ index: Int) {
        guard index >= 0 && index < matches.count else { return }
        selection = index
    }

    /// The keys the menu owns while it is open. Each returns false when the
    /// menu cannot act, so ordinary editing — and Enter's send — is untouched.
    func move(_ delta: Int) -> Bool {
        guard isOpen, !matches.isEmpty else { return false }
        selection = SlashCommands.move(selection: selection, count: matches.count, delta: delta)
        return true
    }

    /// The row Enter/Tab would take, or nil when there is nothing to take —
    /// with "No commands" showing, Enter still sends the draft as typed,
    /// because `/whatever` may well be a command the host did not list.
    var highlighted: CommandP? {
        guard isOpen, selection >= 0 && selection < matches.count else { return nil }
        return matches[selection]
    }

    /// Escape, when it does reach the text view (a path the key monitor does
    /// not cover). Same veto as the monitor's.
    func cancel() -> Bool {
        guard isOpen else { return false }
        dismiss()
        return true
    }
}

/// The command list, drawn ABOVE the composer.
///
/// A SwiftUI overlay, NEVER an NSPopover: the notch is a non-activating panel,
/// and a popover takes key focus off the text view — which fires
/// composerFocus(false) and ends the dictation handoff. An overlay also stays
/// out of the composer's own layout, so it cannot feed the text view's height
/// measurement.
struct SlashCommandMenu: View {
    @ObservedObject var state: SlashMenuState
    let accept: (CommandP) -> Void

    /// FIXED, not measured. An overlay is proposed its parent's size, so a list
    /// that sized itself from its content would be squashed to the composer's
    /// own height — and measuring it back would be the measure/set loop this
    /// surface has spun a core on before. Rows are one line by construction, so
    /// the height is arithmetic.
    static let rowHeight: CGFloat = 30
    static let visibleRows = 6
    /// The composer's own radius and inset, so the two read as one family:
    /// row highlights are concentric with the panel (radius minus inset).
    static let radius: CGFloat = 14
    /// Fully opaque, and dark enough that every tone's composer tint over it
    /// still reads as the composer.
    static let opaqueBase = Color(red: 0.075, green: 0.080, blue: 0.092)
    static let inset: CGFloat = 5

    /// The menu's full height for this many matches — arithmetic, so the
    /// composer can lift the menu clear of itself without measuring anything.
    static func height(matches: Int) -> CGFloat {
        CGFloat(max(1, min(matches, visibleRows))) * rowHeight + inset * 2
    }
    private var rowHeight: CGFloat { Self.rowHeight }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if state.matches.isEmpty {
                Text("No commands")
                    .font(.system(size: 12))
                    .foregroundColor(Theme.textFaint)
                    .padding(.horizontal, 9)
                    .frame(height: rowHeight)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(state.matches.enumerated()), id: \.offset) { index, command in
                                row(command, selected: index == state.selection)
                                    .id(index)
                                    .onTapGesture { accept(command) }
                                    .onHover { if $0 { state.select(index) } }
                            }
                        }
                    }
                    .frame(height: CGFloat(min(state.matches.count, Self.visibleRows)) * rowHeight)
                    .onChange(of: state.selection) { proxy.scrollTo($0) }
                }
            }
        }
        .padding(Self.inset)
        // OPAQUE FIRST, then the composer's own tint. composerFill is
        // translucent, which is right for a field over the bare ground but
        // wrong for a menu floating over the transcript: the conversation
        // showed straight through and the rows became unreadable. The solid
        // base hides whatever is behind; the tint on top keeps it the same
        // family as the composer.
        .background(ZStack {
            RoundedRectangle(cornerRadius: Self.radius).fill(Self.opaqueBase)
            RoundedRectangle(cornerRadius: Self.radius).fill(Theme.composerFill)
        })
        .overlay(RoundedRectangle(cornerRadius: Self.radius).stroke(Theme.composerEdge, lineWidth: 0.75))
        .clipShape(RoundedRectangle(cornerRadius: Self.radius))
        .shadow(color: .black.opacity(0.45), radius: 16, y: 4)
    }

    private func row(_ command: CommandP, selected: Bool) -> some View {
        HStack(spacing: 8) {
            // The same blue a chosen skill wears in the draft, so the row and
            // the token it inserts are recognisably one thing.
            Image(systemName: "puzzlepiece.extension")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(Theme.cLink)
                .frame(width: 14)
            Text(command.name.isEmpty ? command.title : command.name)
                .font(.system(size: 12.5, weight: .medium))
                .foregroundColor(Theme.text)
                .lineLimit(1)
            if !command.argumentHint.isEmpty {
                Text(command.argumentHint)
                    .font(.system(size: 11.5))
                    .foregroundColor(Theme.textFaint)
                    .lineLimit(1)
            }
            if !subtitle(command).isEmpty {
                Text(subtitle(command))
                    .font(.system(size: 11.5))
                    .foregroundColor(Theme.textDim)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 10)
            if !command.scope.isEmpty {
                Text(command.scope)
                    .font(.system(size: 11))
                    .foregroundColor(Theme.textFaint)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 9)
        .frame(height: rowHeight)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Self.radius - Self.inset)
            .fill(selected ? Theme.raisedHover : Color.clear))
        .contentShape(Rectangle())
    }

    /// One line, and the description is what it is for. `title` is a prettier
    /// spelling of the name we already show, so it only speaks when there is
    /// nothing else to say.
    private func subtitle(_ command: CommandP) -> String {
        if !command.description.isEmpty { return command.description }
        return command.title.lowercased() == command.name.lowercased() ? "" : command.title
    }
}
