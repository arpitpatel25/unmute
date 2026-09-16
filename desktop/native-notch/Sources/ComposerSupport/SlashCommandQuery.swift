import Foundation

/// One command the host offers for this thread.
///
/// A protocol rather than a struct so the wire type (IPC's `CommandP`) IS the
/// model — a parallel struct would mean a mapping step, and a mapping step is
/// where `token` gets "helpfully" rebuilt from `name`. It must not be: the
/// token is provider-native ("/name" for Claude, "$name" for Codex) and only
/// the host knows which.
public protocol SlashCommandItem {
    var name: String { get }
    var title: String { get }
    var description: String { get }
    var scope: String { get }
    var token: String { get }
}

public enum SlashCommands {
    /// A menu is scanned, not paged. Past a few dozen rows the list is no
    /// longer a menu, and filtering is the way through it.
    public static let listLimit = 50

    /// The query being typed, or nil when this draft is not a command at all.
    ///
    /// The menu opens only while the WHOLE draft is the command: "/", "/fr" and
    /// "/frontend-design" are a command being typed; "hello /x" and "/fr more"
    /// are prose that happens to contain a slash, and popping a menu over them
    /// would fight the user mid-sentence.
    public static func query(for draftText: String) -> String? {
        guard draftText.hasPrefix("/") else { return nil }
        let rest = draftText.dropFirst()
        guard rest.allSatisfy(isTokenCharacter) else { return nil }
        return String(rest)
    }

    private static func isTokenCharacter(_ c: Character) -> Bool {
        guard c.isASCII else { return false }
        return c.isLetter || c.isNumber || c == "_" || c == ":" || c == "." || c == "-"
    }

    /// Case-insensitive, in three bands: what starts with the query, then what
    /// merely contains it in the name, then what only the prose mentions. The
    /// band is the ranking — within one, the host's own order is kept, so the
    /// list does not reshuffle under the selection as a letter is typed.
    public static func filter<C: SlashCommandItem>(_ commands: [C], query: String,
                                                   limit: Int = listLimit) -> [C] {
        let q = query.lowercased()
        guard !q.isEmpty else { return Array(commands.prefix(limit)) }
        var prefixed: [C] = [], inName: [C] = [], inProse: [C] = []
        for c in commands {
            let name = c.name.lowercased()
            if name.hasPrefix(q) { prefixed.append(c) }
            else if name.contains(q) { inName.append(c) }
            else if c.title.lowercased().contains(q) || c.description.lowercased().contains(q) { inProse.append(c) }
        }
        return Array((prefixed + inName + inProse).prefix(limit))
    }

    /// ↑/↓ WRAP. The list is short and both ends are a destination: pressing ↑
    /// first to reach the last row is how every completion menu on the platform
    /// behaves, and clamping makes the first keystroke do nothing.
    public static func move(selection: Int, count: Int, delta: Int) -> Int {
        guard count > 0 else { return 0 }
        let bounded = min(max(selection, 0), count - 1)
        return ((bounded + delta) % count + count) % count
    }

    /// The list shrinks under the selection as the query narrows; the highlight
    /// follows it rather than pointing past the end.
    public static func clamp(selection: Int, count: Int) -> Int {
        count <= 0 ? 0 : min(max(selection, 0), count - 1)
    }

    /// The token VERBATIM, plus the one space that separates it from the prompt
    /// the user carries on typing.
    public static func accepted(token: String) -> String { token + " " }
}
