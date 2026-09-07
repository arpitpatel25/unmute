import Foundation

/// WHAT A LINK *IS*, never who owns it.
///
/// Codex desktop draws a YouTube play mark beside a `youtube.com` link. That
/// icon is not in the data — Codex recognises the hostname. Copying that means
/// keeping a table of brands, and a brand table is wrong for every site not in
/// it, goes stale the day a logo changes, and nothing in the build catches
/// either failure. It is the same shape of mistake as hardcoding another
/// product's model ids.
///
/// So the glyph is derived from facts we can actually establish: the scheme, and
/// for a local path, the filesystem itself. A site nobody has heard of gets the
/// same correct treatment as YouTube — a link mark and readable text — rather
/// than a blank where a brand icon was supposed to be.
///
/// DELIBERATELY NOT FAVICONS. Fetching `/favicon.ico` would be self-updating and
/// brand-accurate, but it tells that host you are looking at their link. This
/// surface shows an agent's output about private work; that is a real leak, not
/// a theoretical one. Revisit only as an explicit, off-by-default setting.
public enum LinkKind: String, Equatable, Sendable {
    case web
    case file
    case folder
    case image
    case mail
    case phone
    /// A card already in Unmute. Not a place on the internet or the disk — the
    /// only link here that resolves INSIDE the app, by moving the pocket to a
    /// session rather than opening anything.
    case session
}

/// Extensions we are willing to call an image. Bounded and boring on purpose —
/// unlike a brand list this does not rot, because the set of raster formats a
/// markdown link points at does not change month to month.
private let imageExtensions: Set<String> = [
    "png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff", "tif", "svg", "avif",
]

/// Classify a markdown link destination.
///
/// `isDirectory` is injected so the classifier stays pure and testable; the
/// default consults the real filesystem. It is only ever asked about LOCAL
/// paths, so this never touches the network.
public func linkKind(
    for destination: String,
    isDirectory: (String) -> Bool = { path in
        var dir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: path, isDirectory: &dir)
        return exists && dir.boolValue
    }
) -> LinkKind {
    let raw = destination.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !raw.isEmpty else { return .web }

    let lower = raw.lowercased()
    if sessionTaskID(from: raw) != nil { return .session }
    if lower.hasPrefix("mailto:") { return .mail }
    if lower.hasPrefix("tel:") || lower.hasPrefix("sms:") { return .phone }

    // A LOCAL PATH, however it was written. Codex writes both forms: a bare
    // absolute path, and the same path behind `file://`.
    if let path = localPath(from: raw) {
        // A trailing slash is the author SAYING it is a directory, and it can be
        // trusted even when the path does not exist on this machine — a link to
        // somebody else's tree still deserves a folder mark.
        if path.hasSuffix("/") { return .folder }
        if isDirectory(path) { return .folder }
        if imageExtensions.contains((path as NSString).pathExtension.lowercased()) { return .image }
        return .file
    }

    return .web
}

/// The task a `unmute://task/<id>` link addresses, or nil for anything else.
///
/// The Agent hands back a session by writing one of these instead of repeating
/// what the session said: the answer belongs in that session, and this is how
/// somebody gets to it in one tap. Deliberately a URL rather than a bespoke
/// block — markdown is already what the Agent writes and what this view
/// renders, so a link costs no new protocol on either side.
///
/// Strict about shape. A malformed or foreign `unmute://` URL classifies as an
/// ordinary web link and opens the way any other would, rather than silently
/// addressing the wrong card.
public func sessionTaskID(from raw: String) -> String? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.lowercased().hasPrefix("unmute://task/") else { return nil }
    let id = String(trimmed.dropFirst("unmute://task/".count))
        .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        .removingPercentEncoding ?? ""
    guard !id.isEmpty, !id.contains("/"), id.count <= 128 else { return nil }
    return id
}

/// The local filesystem path a destination refers to, or nil if it does not
/// refer to one.
///
/// `~` is expanded because agents write `~/.codex/sessions` constantly, and a
/// path we refuse to expand is a path we then wrongly report as a plain file.
///
/// Public because the renderer needs the SAME answer when it decides whether a
/// click should be sent as `openArtifact(type: "path")` or `type: "url"`. Two
/// separate notions of "is this local" would eventually disagree.
public func localPath(from raw: String) -> String? {
    if raw.lowercased().hasPrefix("file://") {
        // Percent-encoding is real here: `file:///Users/a%20b/c`.
        if let url = URL(string: raw), url.isFileURL { return url.path }
        return String(raw.dropFirst("file://".count)).removingPercentEncoding
    }
    if raw.hasPrefix("/") { return raw }
    if raw == "~" || raw.hasPrefix("~/") { return (raw as NSString).expandingTildeInPath }
    return nil
}
