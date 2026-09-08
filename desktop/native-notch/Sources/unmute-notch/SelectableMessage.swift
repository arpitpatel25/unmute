import SwiftUI
import AppKit
import Markdown
import MarkdownSupport

/// One native text storage per message makes drag selection span paragraphs,
/// lists, and tables instead of stopping at each SwiftUI Text boundary.
struct SelectableMessage: NSViewRepresentable {
    let text: String
    var size: CGFloat = 14
    var color: Color = Theme.text

    func makeNSView(context: Context) -> NSTextView {
        let view = NSTextView()
        view.isEditable = false
        view.isSelectable = true
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = false
        view.textContainer?.heightTracksTextView = false
        view.isHorizontallyResizable = false
        view.isVerticallyResizable = false
        view.delegate = context.coordinator
        return view
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func updateNSView(_ view: NSTextView, context: Context) {
        let ink = NSColor(color)
        guard context.coordinator.text != text || context.coordinator.color != ink else { return }
        context.coordinator.text = text
        context.coordinator.color = ink
        view.textStorage?.setAttributedString(MessageAttributedText.render(text, size: size, color: ink))
        view.linkTextAttributes = [.foregroundColor: NSColor(Theme.cLink), .underlineStyle: NSUnderlineStyle.single.rawValue]
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSTextView, context: Context) -> CGSize? {
        let width = max(1, proposal.width ?? 760)
        guard let container = nsView.textContainer, let layout = nsView.layoutManager else { return nil }
        container.containerSize = CGSize(width: width, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        return CGSize(width: width, height: ceil(layout.usedRect(for: container).height))
    }
    final class Coordinator: NSObject, NSTextViewDelegate {
        var text: String?
        var color: NSColor?
        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            guard let url = link as? URL ?? (link as? String).flatMap(URL.init(string:)) else { return false }
            if let task = sessionTaskID(from: url.absoluteString) { IPC.emit(.pocketFocusTask(id: task)) }
            else { IPC.emit(.openArtifact(type: url.isFileURL ? "path" : "url", value: url.isFileURL ? url.path : url.absoluteString)) }
            return true
        }
    }
}

private enum MessageAttributedText {
    static func render(_ text: String, size: CGFloat, color: NSColor) -> NSAttributedString {
        let output = NSMutableAttributedString(string: "")
        let paragraph = NSMutableParagraphStyle()
        paragraph.paragraphSpacing = 9
        paragraph.lineSpacing = 3
        let base: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size), .foregroundColor: color, .paragraphStyle: paragraph]
        func append(_ value: String, _ attrs: [NSAttributedString.Key: Any]) { output.append(NSAttributedString(string: value, attributes: attrs)) }
        func children(_ node: Markup, _ attrs: [NSAttributedString.Key: Any], _ depth: Int) {
            for child in node.children { visit(child, attrs, depth) }
        }
        func visit(_ node: Markup, _ attrs: [NSAttributedString.Key: Any], _ depth: Int) {
            var next = attrs
            switch node {
            case let value as Markdown.Text: append(value.string, attrs)
            case let value as InlineCode:
                next[.font] = NSFont.monospacedSystemFont(ofSize: size * 0.93, weight: .regular)
                next[.backgroundColor] = NSColor(Theme.raised)
                append(value.code, next)
            case is Strong:
                next[.font] = NSFontManager.shared.convert(attrs[.font] as! NSFont, toHaveTrait: .boldFontMask)
                children(node, next, depth)
            case is Emphasis:
                next[.font] = NSFontManager.shared.convert(attrs[.font] as! NSFont, toHaveTrait: .italicFontMask)
                children(node, next, depth)
            case is Strikethrough:
                next[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
                children(node, next, depth)
            case let value as Markdown.Link:
                if let destination = value.destination, let url = URL(string: destination) { next[.link] = url }
                children(node, next, depth)
            case let value as Markdown.Image:
                append(value.plainText, attrs)
            case is SoftBreak: append(" ", attrs)
            case is LineBreak: append("\n", attrs)
            case let value as Heading:
                next[.font] = NSFont.systemFont(ofSize: size * (value.level <= 1 ? 1.25 : 1.1), weight: .semibold)
                children(node, next, depth); append("\n", next)
            case let value as CodeBlock:
                next[.font] = NSFont.monospacedSystemFont(ofSize: size * 0.9, weight: .regular)
                next[.backgroundColor] = NSColor(Theme.raised)
                append(value.code.hasSuffix("\n") ? value.code : value.code + "\n", next)
            case let value as UnorderedList:
                for item in value.listItems { append(String(repeating: "  ", count: depth) + "•  ", attrs); children(item, attrs, depth + 1) }
            case let value as OrderedList:
                for (index, item) in value.listItems.enumerated() { append(String(repeating: "  ", count: depth) + "\(Int(value.startIndex) + index).  ", attrs); children(item, attrs, depth + 1) }
            case let value as Markdown.Table:
                let rows = [Array(value.head.cells).map { $0 as Markup }] + value.body.rows.map { Array($0.cells).map { $0 as Markup } }
                let table = NSTextTable(); table.numberOfColumns = max(1, rows.first?.count ?? 1)
                table.layoutAlgorithm = .fixedLayoutAlgorithm
                for (rowIndex, row) in rows.enumerated() {
                    for (column, cell) in row.enumerated() {
                        let block = NSTextTableBlock(table: table, startingRow: rowIndex, rowSpan: 1, startingColumn: column, columnSpan: 1)
                        block.setWidth(6, type: .absoluteValueType, for: .padding)
                        block.setWidth(0.5, type: .absoluteValueType, for: .border, edge: .maxY)
                        block.setBorderColor(NSColor(Theme.hairline))
                        let style = paragraph.mutableCopy() as! NSMutableParagraphStyle
                        style.textBlocks = [block]
                        var cellAttrs = attrs; cellAttrs[.paragraphStyle] = style
                        if rowIndex == 0 { cellAttrs[.font] = NSFont.systemFont(ofSize: size, weight: .semibold) }
                        children(cell, cellAttrs, depth); append("\n", cellAttrs)
                    }
                }
            case is ThematicBreak: append("────────────────────────\n", attrs)
            case is Paragraph: children(node, attrs, depth); append("\n", attrs)
            default: children(node, attrs, depth)
            }
        }
        visit(Document(parsing: text), base, 0)
        while output.length > 0, output.string.hasSuffix("\n") {
            output.deleteCharacters(in: NSRange(location: output.length - 1, length: 1))
        }
        return output
    }
}
