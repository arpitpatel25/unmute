import Foundation

// BLOCK MARKDOWN, because Apple's inline parser does not do blocks.
//
// `AttributedString(markdown:)` with `.inlineOnlyPreservingWhitespace` renders
// **bold** and `code` and nothing else — so every `- item` and `## heading` an
// agent writes arrived on screen as literal dashes and hashes. Bullets, nesting
// and headings are the single biggest visual gap against Codex, and they are
// all block-level.
//
// This splits text into blocks; each block's inline spans are still handed to
// AttributedString, which is good at exactly that part.
//
// Numbers measured from the running Codex window on 2026-08-16 — see §8a of
// docs/superpowers/specs/2026-08-16-chat-view-blocks.md.

public enum MDBlock: Equatable, Sendable {
    case paragraph(String)
    /// `depth` 0 is a `disc` bullet; 1 and deeper are `circle`, matching Codex.
    case bullet(text: String, depth: Int)
    case ordered(text: String, number: Int, depth: Int)
    case heading(text: String, level: Int)
    case code(text: String, language: String?)
    case rule
}

public enum Markdown {
    /// Split markdown into renderable blocks.
    ///
    /// Deliberately small: the shapes agents actually emit — paragraphs, `-`/`*`
    /// bullets with two-space nesting, `1.` lists, ATX headings, fenced code,
    /// and `---`. Anything else stays a paragraph, which is the honest fallback
    /// because the inline pass will still bold and code-chip it.
    public static func blocks(_ source: String) -> [MDBlock] {
        var out: [MDBlock] = []
        var paragraph: [String] = []
        var fence: (lang: String?, lines: [String])?

        func flushParagraph() {
            let joined = paragraph.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            if !joined.isEmpty { out.append(.paragraph(joined)) }
            paragraph = []
        }

        for rawLine in source.components(separatedBy: .newlines) {
            let line = rawLine
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // fenced code runs verbatim, including blank lines
            if trimmed.hasPrefix("```") {
                if var f = fence {
                    out.append(.code(text: f.lines.joined(separator: "\n"), language: f.lang))
                    f.lines = []
                    fence = nil
                } else {
                    flushParagraph()
                    let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                    fence = (lang.isEmpty ? nil : lang, [])
                }
                continue
            }
            if fence != nil { fence!.lines.append(line); continue }

            if trimmed.isEmpty { flushParagraph(); continue }

            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                flushParagraph(); out.append(.rule); continue
            }

            if let h = heading(trimmed) { flushParagraph(); out.append(h); continue }

            let indent = line.prefix(while: { $0 == " " || $0 == "\t" })
                .reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }

            if let b = bullet(trimmed, indent: indent) { flushParagraph(); out.append(b); continue }
            if let o = ordered(trimmed, indent: indent) { flushParagraph(); out.append(o); continue }

            paragraph.append(trimmed)
        }

        if let f = fence, !f.lines.isEmpty { out.append(.code(text: f.lines.joined(separator: "\n"), language: f.lang)) }
        flushParagraph()
        return out
    }

    private static func heading(_ t: String) -> MDBlock? {
        var level = 0
        for ch in t { if ch == "#" { level += 1 } else { break } }
        guard level > 0, level <= 6 else { return nil }
        let rest = String(t.dropFirst(level)).trimmingCharacters(in: .whitespaces)
        guard !rest.isEmpty else { return nil }
        return .heading(text: rest, level: level)
    }

    private static func bullet(_ t: String, indent: Int) -> MDBlock? {
        for mark in ["- ", "* ", "• ", "◦ "] where t.hasPrefix(mark) {
            let body = String(t.dropFirst(mark.count)).trimmingCharacters(in: .whitespaces)
            guard !body.isEmpty else { return nil }
            // Two spaces per level is the convention agents actually emit.
            return .bullet(text: body, depth: min(indent / 2, 3))
        }
        return nil
    }

    private static func ordered(_ t: String, indent: Int) -> MDBlock? {
        var digits = ""
        var rest = Substring(t)
        while let f = rest.first, f.isNumber { digits.append(f); rest = rest.dropFirst() }
        guard !digits.isEmpty, let n = Int(digits) else { return nil }
        guard rest.hasPrefix(". ") || rest.hasPrefix(") ") else { return nil }
        let body = String(rest.dropFirst(2)).trimmingCharacters(in: .whitespaces)
        guard !body.isEmpty else { return nil }
        return .ordered(text: body, number: n, depth: min(indent / 2, 3))
    }

    /// `disc` then `circle`, exactly as Codex renders them. Dots, not dashes —
    /// which is what the old renderer showed because the dash was never parsed.
    public static func marker(depth: Int) -> String {
        depth == 0 ? "•" : "◦"
    }
}
