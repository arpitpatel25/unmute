import AppKit
import SwiftUI

/// THE PROVIDER LOGOS, AND THE ONE PLACE THEY LIVE.
///
/// Same pattern as UnMarkArt: base64 PNG compiled in, because the notch is a
/// separate binary from the Electron app and cannot read the renderer's asset
/// folder at runtime. One file to change when a logo does.
///
/// EMPTY UNTIL THE REAL FILES ARE EMBEDDED, deliberately. The marks belong to
/// OpenAI and Anthropic; drawing an approximation from memory would put a wrong
/// logo on every card, and "close enough" brand art is the same mistake as the
/// four invented Codex model ids that shipped in this branch a day ago — a
/// confident guess about someone else's product that nothing can catch.
/// `ProviderMark` falls back to the coloured dot the wall already used, so an
/// absent asset degrades to the previous design instead of to a hole.
///
/// TO EMBED (one command per logo, from the repo root):
///
///   ./native-notch/tools/embed-provider-logo.sh claude ~/path/claude.png
///   ./native-notch/tools/embed-provider-logo.sh codex  ~/path/codex.png
enum ProviderMarkArt {

    /// A logo plus how much of the box its INK should occupy.
    ///
    /// `scale` exists because matching the frame does not match the mark: a
    /// logo drawn with generous internal padding reads smaller than a tight one
    /// at the same point size, and the eye compares the marks, not the boxes.
    /// Measured per logo when it is embedded — never guessed.
    struct Art { let image: NSImage; let scale: CGFloat }

    // ── The embedded art. Filled by tools/embed-provider-logo.sh ──
    // Base64 PNG, or "" while absent.
    private static let claudeB64 = ""
    private static let codexB64 = ""
    /// Ink-to-box ratio, measured from each logo's opaque bounds at embed time.
    private static let claudeScale: CGFloat = 1.0
    private static let codexScale: CGFloat = 1.0

    /// The vendor behind a backend id. Two surfaces per vendor share one mark:
    /// Codex CLI and Codex desktop are the same product wearing different
    /// clothes, and the terminal glyph is what distinguishes them.
    private static func vendor(_ backend: String?) -> String {
        switch backend {
        case "codex", "codex-desktop": return "codex"
        default:                        return "claude"   // absent ⇒ Claude, the compatibility default
        }
    }

    static func image(_ backend: String?) -> Art? {
        let isCodex = vendor(backend) == "codex"
        let b64 = isCodex ? codexB64 : claudeB64
        guard !b64.isEmpty,
              let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters),
              let img = NSImage(data: data) else { return nil }
        return Art(image: img, scale: isCodex ? codexScale : claudeScale)
    }

    /// The fallback when there is no logo: the vendor's name, short enough to
    /// sit where a mark would. NOT a colour — a dot beside the status dot is two
    /// dots and no information, which is what the first version shipped.
    static func shortName(_ backend: String?) -> String {
        vendor(backend) == "codex" ? "Codex" : "Claude"
    }

    /// For VoiceOver and the tooltip. The label is gone from the row; it must
    /// not be gone from the accessibility tree — an icon-only row is unreadable
    /// to a screen reader otherwise.
    static func name(_ backend: String?) -> String {
        switch backend {
        case "codex":               return "Codex CLI"
        case "codex-desktop":       return "Codex desktop"
        case "claude-code-desktop": return "Claude desktop"
        default:                    return "Claude Code CLI"
        }
    }
}
