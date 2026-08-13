import SwiftUI
import Markdown
import MarkdownSupport

// `Text`, `Link` and `Image` all exist in BOTH SwiftUI and Markdown, and this
// file is the one place that has to talk about both at once. The view layer wins
// the bare names — it is what almost every line here means — and the parser's
// node types are spelled out as `Markdown.Link`, `Markdown.Image`,
// `Markdown.Text` at the handful of sites that match on them.
private typealias Text = SwiftUI.Text
private typealias Image = SwiftUI.Image

private final class ParsedMarkdownDocument {
    let value: Document
    init(_ value: Document) { self.value = value }
}

/// Markdown is a content concern, not a geometry concern. SwiftUI asks a view
/// for its body at every display-linked width step; caching by source text keeps
/// those steps to layout only instead of reparsing the answer each time.
private final class MarkdownDocumentCache {
    static let shared = MarkdownDocumentCache()
    private let values = NSCache<NSString, ParsedMarkdownDocument>()

    private init() {
        values.countLimit = 160
        values.totalCostLimit = 12 * 1024 * 1024
    }

    func document(for text: String) -> Document {
        let key = text as NSString
        if let cached = values.object(forKey: key) { return cached.value }
        let parsed = ParsedMarkdownDocument(Document(parsing: text))
        values.setObject(parsed, forKey: key, cost: text.utf8.count)
        return parsed.value
    }
}

// MARK: - Agent markdown, parsed by a real engine

/// WHAT AN AGENT WROTE, rendered the way it was written.
///
/// Codex and Claude hand us ordinary, complete markdown — verified against real
/// rollouts. The chips and links in Codex desktop's transcript are nothing more
/// exotic than `` `code` `` and `[text](href)`. Nothing is withheld from us, so
/// every formatting gap was ours.
///
/// This used to be a hand-rolled line classifier, and it could not see tables at
/// all: a pipe table printed as literal `|` rows. The dashboard had a SECOND
/// hand-rolled renderer that could see tables but printed ``` fences literally.
/// Two independent approximations of CommonMark, each missing a different half —
/// which is the argument for parsing with something real instead of extending
/// either one. `swift-markdown` is Apple's binding to cmark-gfm, the same C
/// engine GitHub parses with.
///
/// The API is unchanged on purpose: every existing call site renders the same
/// prose, only correctly.
struct RichText: View {
    let text: String
    var size: CGFloat = 14
    /// Callers that render SECONDARY prose (the warm-up strip) dim this; the
    /// transcript's own answers keep the default.
    var color: Color = Theme.text

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            let children = Array(document.children)
            ForEach(children.indices, id: \.self) { i in
                block(children[i], depth: 0)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
        // A LINK OPENS WHERE THE USER WORKS, not inside the notch. This reuses
        // the artifact channel the Stage's own buttons already go through, so
        // there is one place that decides what opening something means.
        .environment(\.openURL, OpenURLAction { url in
            if url.isFileURL {
                IPC.emit(.openArtifact(type: "path", value: url.path))
            } else {
                IPC.emit(.openArtifact(type: "url", value: url.absoluteString))
            }
            return .handled
        })
    }

    /// Body runs at every live width step. Parsing once per distinct answer
    /// keeps resizing proportional to visible layout rather than transcript size.
    private var document: Document { MarkdownDocumentCache.shared.document(for: text) }

    // MARK: Blocks

    /// `AnyView` because block rendering RECURSES — a quote holds blocks, a list
    /// item holds blocks — and a `some View` return type cannot describe its own
    /// recursion.
    private func block(_ markup: Markup, depth: Int) -> AnyView {
        switch markup {
        case let p as Paragraph:
            return AnyView(inline(p).fixedSize(horizontal: false, vertical: true))

        case let h as Heading:
            return AnyView(inline(h, weight: .semibold, scale: h.level <= 1 ? 1.25 : 1.1)
                .fixedSize(horizontal: false, vertical: true))

        case let list as UnorderedList:
            return AnyView(VStack(alignment: .leading, spacing: 6) {
                let items = Array(list.listItems)
                ForEach(items.indices, id: \.self) { i in
                    // NESTING SURVIVES, and it is now the parser's business
                    // rather than a leading-space count that a trim destroyed.
                    bulletRow(marker: depth > 0 ? "◦" : "•", item: items[i], depth: depth)
                }
            })

        case let list as OrderedList:
            return AnyView(VStack(alignment: .leading, spacing: 6) {
                let items = Array(list.listItems)
                let start = Int(list.startIndex)
                ForEach(items.indices, id: \.self) { i in
                    bulletRow(marker: "\(start + i).", item: items[i], depth: depth)
                }
            })

        case let code as CodeBlock:
            return AnyView(codeBox(code.code, language: code.language))

        case let quote as BlockQuote:
            return AnyView(VStack(alignment: .leading, spacing: 6) {
                let kids = Array(quote.children)
                ForEach(kids.indices, id: \.self) { i in block(kids[i], depth: depth) }
            }
            .padding(.leading, 9)
            .overlay(Rectangle().fill(Theme.hairline).frame(width: 2), alignment: .leading))

        case is ThematicBreak:
            return AnyView(Rectangle().fill(Theme.hairlineSoft).frame(height: 1))

        case let table as Markdown.Table:
            return AnyView(tableGrid(table))

        case let html as HTMLBlock:
            // Rare, and there is nothing honest to do with it but show it.
            return AnyView(codeBox(html.rawHTML, language: nil))

        default:
            // Anything the parser knows and this renderer does not: show its
            // text rather than dropping it. Silence would lose content.
            return AnyView(Text(markup.format())
                .font(.system(size: size))
                .foregroundColor(color)
                .fixedSize(horizontal: false, vertical: true))
        }
    }

    private func bulletRow(marker: String, item: ListItem, depth: Int) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(marker)
                .font(.system(size: size))
                .foregroundColor(Theme.textDim)
                .frame(minWidth: 14, alignment: .trailing)
            VStack(alignment: .leading, spacing: 6) {
                let kids = Array(item.children)
                ForEach(kids.indices, id: \.self) { i in
                    // A nested list inside the item comes back through `block`
                    // at depth+1, which is where the indent and the hollow
                    // marker come from.
                    block(kids[i], depth: depth + 1)
                }
            }
        }
        .padding(.leading, depth > 0 ? 16 : 0)
    }

    private func codeBox(_ body: String, language: String?) -> some View {
        // Fenced blocks are the commonest construct in agent output. Verbatim,
        // monospaced, on their own ground so they read as a quoted artifact
        // rather than as more prose.
        let lines = body.hasSuffix("\n")
            ? String(body.dropLast()).components(separatedBy: "\n")
            : body.components(separatedBy: "\n")
        return VStack(alignment: .leading, spacing: 2) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(.system(size: size * 0.72, weight: .semibold))
                    .foregroundColor(Theme.textFaint)
            }
            ForEach(lines.indices, id: \.self) { i in
                Text(lines[i].isEmpty ? " " : lines[i])
                    .font(.system(size: size * 0.88, design: .monospaced))
                    .foregroundColor(color)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 9).padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 7).fill(Theme.sunken))
    }

    /// A GFM table as an actual grid.
    ///
    /// Cells WRAP rather than the table scrolling sideways: this surface is
    /// narrow by nature, and a horizontal scroller inside the Stage's vertical
    /// one hides content behind a gesture nobody thinks to try.
    private func tableGrid(_ table: Markdown.Table) -> some View {
        let head = Array(table.head.cells)
        let rows = Array(table.body.rows)
        return Grid(alignment: .topLeading, horizontalSpacing: 12, verticalSpacing: 6) {
            GridRow {
                ForEach(head.indices, id: \.self) { c in
                    inline(head[c], weight: .semibold)
                        .fixedSize(horizontal: false, vertical: true)
                        .gridColumnAlignment(gridAlignment(table.columnAlignments, c))
                }
            }
            // A view that is NOT inside a GridRow spans every column, which is
            // exactly what a rule under the header wants.
            Rectangle().fill(Theme.hairline).frame(height: 1)
            ForEach(rows.indices, id: \.self) { r in
                let cells = Array(rows[r].cells)
                GridRow {
                    ForEach(cells.indices, id: \.self) { c in
                        inline(cells[c]).fixedSize(horizontal: false, vertical: true)
                    }
                }
                if r < rows.count - 1 {
                    Rectangle().fill(Theme.hairlineSoft).frame(height: 1)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func gridAlignment(_ alignments: [Markdown.Table.ColumnAlignment?], _ i: Int) -> HorizontalAlignment {
        guard i < alignments.count, let a = alignments[i] else { return .leading }
        switch a {
        case .left: return .leading
        case .center: return .center
        case .right: return .trailing
        }
    }

    // MARK: Inline

    /// Style carried DOWN the inline tree, because emphasis nests: bold inside a
    /// link inside a heading all have to survive together.
    private struct Style {
        var bold = false
        var italic = false
        var strike = false
        var weight: Font.Weight = .regular
        var scale: CGFloat = 1
        /// Set once a link is entered, so EVERY run beneath it — including a
        /// bold word or a code chip inside the link text — is tappable and
        /// tinted, not just the first plain run.
        var link: URL?
    }

    /// One piece of an inline run.
    ///
    /// Two cases because a link's glyph is an SF Symbol and an `AttributedString`
    /// cannot hold one, while the link attribute itself can ONLY live on an
    /// `AttributedString`. Keeping them as separate segments and concatenating
    /// at the end gets both, and the paragraph still lays out as a single
    /// wrapping `Text` rather than a row of pasted-together views.
    private enum Segment {
        case run(AttributedString)
        case symbol(String, Color)
    }

    private func inline(_ container: Markup, weight: Font.Weight = .regular, scale: CGFloat = 1) -> Text {
        var st = Style()
        st.weight = weight
        st.scale = scale
        return assemble(container.children.flatMap { segments($0, st) })
    }

    private func assemble(_ segments: [Segment]) -> Text {
        segments.reduce(Text("")) { acc, seg in
            switch seg {
            case let .run(a):
                return acc + Text(a)
            case let .symbol(name, tint):
                // `Text(Image)` renders the symbol inline, at the surrounding
                // text's size, and wraps with it.
                return acc + Text(SwiftUI.Image(systemName: name)).foregroundColor(tint)
            }
        }
    }

    private func segments(_ markup: Markup, _ st: Style) -> [Segment] {
        switch markup {
        case let t as Markdown.Text:
            return [.run(styled(t.string, st))]

        case let e as Emphasis:
            var s = st; s.italic = true
            return e.children.flatMap { segments($0, s) }

        case let strong as Strong:
            var s = st; s.bold = true
            return strong.children.flatMap { segments($0, s) }

        case let struck as Strikethrough:
            var s = st; s.strike = true
            return struck.children.flatMap { segments($0, s) }

        case let c as InlineCode:
            // A REAL CHIP, not merely a monospaced run. The hair spaces are the
            // only padding available inside a concatenated Text — without them
            // the tint sits flush against the glyphs and reads as a highlighter
            // smear rather than as a chip.
            var a = AttributedString("\u{2009}\(c.code)\u{2009}")
            a.font = .system(size: size * st.scale * 0.92, design: .monospaced)
            a.foregroundColor = st.link == nil ? color : Theme.cLink
            a.backgroundColor = Theme.raised
            if let link = st.link { a.link = link }
            return [.run(a)]

        case let link as Markdown.Link:
            return linkSegments(destination: link.destination ?? "",
                                children: Array(link.children), st: st)

        case let image as Markdown.Image:
            // NEVER FETCHED. A remote image would mean the notch making a
            // network request on behalf of whatever an agent happened to write —
            // the same leak favicons were rejected for. Shown as what it is: a
            // link to a picture.
            let alt = image.plainText.isEmpty ? (image.source ?? "image") : image.plainText
            return linkSegments(destination: image.source ?? "",
                                children: [], fallbackLabel: alt, st: st, forceKind: .image)

        case is SoftBreak:
            return [.run(AttributedString(" "))]

        case is LineBreak:
            return [.run(AttributedString("\n"))]

        case let h as InlineHTML:
            return [.run(styled(h.rawHTML, st))]

        default:
            // Unknown inline containers still render their children rather than
            // vanishing — dropping content is the one unrecoverable failure.
            let kids = Array(markup.children)
            guard !kids.isEmpty else { return [.run(styled(markup.format(), st))] }
            return kids.flatMap { segments($0, st) }
        }
    }

    /// A link, preceded by a glyph that says what KIND of thing it points at.
    ///
    /// The glyph comes from `linkKind` — scheme and filesystem, never a table of
    /// brands. See `LinkGlyph.swift` for why that distinction is the whole
    /// design.
    private func linkSegments(destination: String,
                              children: [Markup],
                              fallbackLabel: String? = nil,
                              st: Style,
                              forceKind: LinkKind? = nil) -> [Segment] {
        let kind = forceKind ?? linkKind(for: destination)
        let resolved = url(for: destination, kind: kind)

        var s = st
        s.link = resolved
        let tint = resolved == nil ? Theme.textFaint : Theme.cLink

        let label: [Segment] = children.isEmpty
            ? [.run(styled(fallbackLabel ?? destination, s))]
            : children.flatMap { segments($0, s) }

        return [.symbol(symbol(for: kind), tint), .run(AttributedString("\u{2009}"))] + label
    }

    private func symbol(for kind: LinkKind) -> String {
        switch kind {
        case .web:    return "link"
        case .file:   return "doc"
        case .folder: return "folder"
        case .image:  return "photo"
        case .mail:   return "envelope"
        case .phone:  return "phone"
        }
    }

    /// Local destinations become real `file://` URLs so the click handler can
    /// tell a path from a URL by asking the URL, not by re-parsing the string.
    private func url(for destination: String, kind: LinkKind) -> URL? {
        switch kind {
        case .file, .folder, .image:
            if let p = localPath(from: destination) { return URL(fileURLWithPath: p) }
            return URL(string: destination)
        case .web, .mail, .phone:
            return URL(string: destination)
        }
    }

    private func styled(_ s: String, _ st: Style) -> AttributedString {
        var a = AttributedString(s)
        var font = Font.system(size: size * st.scale, weight: st.bold ? .semibold : st.weight)
        if st.italic { font = font.italic() }
        a.font = font
        if st.strike { a.strikethroughStyle = .single }
        if let link = st.link {
            a.link = link
            a.foregroundColor = Theme.cLink
            a.underlineStyle = .single
        } else {
            a.foregroundColor = color
        }
        return a
    }
}
