// ax-mcp — background macOS app control for Claude Code via Accessibility APIs.
//
// Design rules:
//   1. NEVER raise, activate, or focus an app. Background is the whole point.
//   2. Direct AXUIElement. No System Events, no AppleScript.
//   3. AXManualAccessibility must be set or Electron apps expose nothing.
//   4. Allowlist: only apps the user named can be touched.
//   5. Zero third-party dependencies. Zero network calls.
//
// Build: swiftc -O main.swift -o ax-mcp -framework Cocoa -framework ApplicationServices

import Foundation
import Cocoa
import ApplicationServices

// ───────────────────────────── allowlist ─────────────────────────────

/// Apps this server is permitted to touch. Set via AX_MCP_ALLOWED env var
/// (comma-separated), or "*" for all. Empty = nothing allowed.
let allowedApps: Set<String> = {
    let raw = ProcessInfo.processInfo.environment["AX_MCP_ALLOWED"] ?? ""
    return Set(raw.split(separator: ",").map {
        $0.trimmingCharacters(in: .whitespaces).lowercased()
    })
}()

func isAllowed(_ name: String) -> Bool {
    allowedApps.contains("*") || allowedApps.contains(name.lowercased())
}

// ───────────────────────────── AX core ─────────────────────────────

func axAttr(_ el: AXUIElement, _ key: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, key as CFString, &v) == .success ? v : nil
}

func axStr(_ el: AXUIElement, _ key: String) -> String? { axAttr(el, key) as? String }

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    (axAttr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func axActions(_ el: AXUIElement) -> [String] {
    var a: CFArray?
    guard AXUIElementCopyActionNames(el, &a) == .success else { return [] }
    return (a as? [String]) ?? []
}

/// The label an LLM should see. Falls back through the usual attributes.
func axLabel(_ el: AXUIElement) -> String {
    for k in [kAXTitleAttribute, kAXDescriptionAttribute, "AXPlaceholderValue",
              kAXValueAttribute, "AXHelp"] as [String] {
        if let s = axAttr(el, k) as? String, !s.isEmpty {
            return s.count > 120 ? String(s.prefix(120)) + "…" : s
        }
    }
    return ""
}

/// CRITICAL: Chromium/Electron ships its a11y tree DISABLED. Setting
/// AXManualAccessibility is what makes Notion/Slack/WhatsApp readable at all.
/// AXEnhancedUserInterface is the AppKit equivalent. Try both, ignore failures.
func enableAX(_ app: AXUIElement) {
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    usleep(250_000)
}

/// Electron apps report AXWindows = [] even with a window open.
/// Fall back to AXMainWindow / AXFocusedWindow.
func axWindow(_ app: AXUIElement, index: Int = 0) -> AXUIElement? {
    if let wins = axAttr(app, kAXWindowsAttribute as String) as? [AXUIElement],
       index < wins.count {
        return wins[index]
    }
    guard index == 0 else { return nil }
    for k in ["AXMainWindow", "AXFocusedWindow"] {
        var v: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, k as CFString, &v) == .success, let v = v {
            return (v as! AXUIElement)
        }
    }
    return nil
}

struct Node {
    let id: Int
    let depth: Int
    let el: AXUIElement
    let role: String
    let label: String
    let actions: [String]
}

func walk(_ root: AXUIElement, maxDepth: Int = 14, maxNodes: Int = 4000) -> [Node] {
    var out: [Node] = []
    var n = 0
    func rec(_ el: AXUIElement, _ d: Int) {
        if d > maxDepth || n >= maxNodes { return }
        let role = axStr(el, kAXRoleAttribute as String) ?? "?"
        let acts = axActions(el).filter { $0 != "AXShowMenu" && $0 != "AXScrollToVisible" }
        out.append(Node(id: n, depth: d, el: el, role: role, label: axLabel(el), actions: acts))
        n += 1
        for c in axChildren(el) { rec(c, d + 1) }
    }
    rec(root, 0)
    return out
}

/// Drop the noise. Electron trees are ~80% unlabeled AXGroup wrappers.
func isInteresting(_ n: Node) -> Bool {
    if !n.actions.isEmpty { return true }
    if n.label.isEmpty { return false }
    return ["AXStaticText", "AXTextField", "AXTextArea", "AXHeading",
            "AXWindow", "AXRow", "AXCell", "AXLink", "AXImage"].contains(n.role)
}

func resolveApp(_ name: String) -> (AXUIElement, pid_t)? {
    for a in NSWorkspace.shared.runningApplications where a.activationPolicy == .regular {
        if (a.localizedName ?? "").lowercased() == name.lowercased() {
            let el = AXUIElementCreateApplication(a.processIdentifier)
            AXUIElementSetMessagingTimeout(el, 8.0)
            enableAX(el)
            return (el, a.processIdentifier)
        }
    }
    return nil
}

// ───────────────────────────── window capture ─────────────────────────────
// Per-window, NOT full-screen. Does not require the window to be frontmost.

func captureWindow(pid: pid_t) -> String? {
    guard let infos = CGWindowListCopyWindowInfo(
        [.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }

    let match = infos.first { info in
        (info[kCGWindowOwnerPID as String] as? pid_t) == pid
            && (info[kCGWindowLayer as String] as? Int) == 0
            && (info[kCGWindowAlpha as String] as? Double ?? 0) > 0
    }
    guard let win = match,
          let wid = win[kCGWindowNumber as String] as? CGWindowID else { return nil }

    guard let img = CGWindowListCreateImage(
        .null, .optionIncludingWindow, wid,
        [.boundsIgnoreFraming, .nominalResolution]) else { return nil }

    let rep = NSBitmapImageRep(cgImage: img)
    // Downscale so we don't blow the model's context on a Retina capture.
    let maxW: CGFloat = 1400
    var target = rep
    if CGFloat(img.width) > maxW {
        let scale = maxW / CGFloat(img.width)
        let w = Int(CGFloat(img.width) * scale), h = Int(CGFloat(img.height) * scale)
        if let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                               bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                               bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
            ctx.interpolationQuality = .high
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
            if let scaled = ctx.makeImage() { target = NSBitmapImageRep(cgImage: scaled) }
        }
    }
    return target.representation(using: .png, properties: [:])?.base64EncodedString()
}

// ───────────────────────────── keys ─────────────────────────────

let keyMap: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46
]

func flags(_ mods: [String]) -> CGEventFlags {
    var f = CGEventFlags()
    for m in mods.map({ $0.lowercased() }) {
        switch m {
        case "cmd", "command": f.insert(.maskCommand)
        case "shift":          f.insert(.maskShift)
        case "opt", "option", "alt": f.insert(.maskAlternate)
        case "ctrl", "control": f.insert(.maskControl)
        default: break
        }
    }
    return f
}

// ───────────────────────────── MCP plumbing ─────────────────────────────

func jsonString(_ obj: Any) -> String {
    guard let d = try? JSONSerialization.data(withJSONObject: obj),
          let s = String(data: d, encoding: .utf8) else { return "{}" }
    return s
}

func emit(_ obj: [String: Any]) {
    print(jsonString(obj))
    fflush(stdout)
}

func textResult(_ id: Any, _ text: String, isError: Bool = false) {
    emit(["jsonrpc": "2.0", "id": id,
          "result": ["content": [["type": "text", "text": text]], "isError": isError]])
}

func imageResult(_ id: Any, _ b64: String, _ note: String) {
    emit(["jsonrpc": "2.0", "id": id, "result": ["content": [
        ["type": "text", "text": note],
        ["type": "image", "data": b64, "mimeType": "image/png"]
    ]]])
}

let tools: [[String: Any]] = [
    ["name": "list_apps",
     "description": "List running apps with windows. Call this first to get exact app names.",
     "inputSchema": ["type": "object", "properties": [:]]],

    ["name": "find",
     "description": "Find UI elements in an app by label and/or role. PREFER THIS over get_tree — it keeps context small. Returns element ids for press/set_value. Does not focus the app.",
     "inputSchema": ["type": "object", "properties": [
        "app": ["type": "string"],
        "label": ["type": "string", "description": "substring, case-insensitive"],
        "role": ["type": "string", "description": "e.g. AXButton, AXTextField"]
     ], "required": ["app"]]],

    ["name": "get_tree",
     "description": "Dump an app's UI tree. Noisy — use find first. Does not focus the app.",
     "inputSchema": ["type": "object", "properties": [
        "app": ["type": "string"],
        "window": ["type": "integer", "description": "window index, default 0"],
        "roles": ["type": "string", "description": "comma-separated role filter"],
        "max_depth": ["type": "integer"],
        "all": ["type": "boolean", "description": "include unlabeled wrapper nodes"]
     ], "required": ["app"]]],

    ["name": "press",
     "description": "Press an element by id (from find/get_tree). Runs in the background — does NOT bring the app forward.",
     "inputSchema": ["type": "object", "properties": [
        "app": ["type": "string"], "id": ["type": "integer"]
     ], "required": ["app", "id"]]],

    ["name": "set_value",
     "description": "Set a text field's value by element id. Background, no focus change.",
     "inputSchema": ["type": "object", "properties": [
        "app": ["type": "string"], "id": ["type": "integer"], "text": ["type": "string"]
     ], "required": ["app", "id", "text"]]],

    ["name": "fill_form",
     "description": "Set several fields at once: {\"id\": \"text\", ...}. One round-trip instead of many.",
     "inputSchema": ["type": "object", "properties": [
        "app": ["type": "string"], "fields": ["type": "object"]
     ], "required": ["app", "fields"]]],

    ["name": "menu_action",
     "description": "Click a menu bar item by path, e.g. 'File > Save'. Often the cleanest way to drive an app.",
     "inputSchema": ["type": "object", "properties": [
        "app": ["type": "string"], "path": ["type": "string"]
     ], "required": ["app", "path"]]],

    ["name": "capture_window",
     "description": "Screenshot ONE app window (not the screen). Use when the tree isn't enough — visual bugs, layout, canvas content — or to verify a result. Does not focus the app. Requires Screen Recording permission.",
     "inputSchema": ["type": "object", "properties": [
        "app": ["type": "string"]
     ], "required": ["app"]]]
]

// ───────────────────────────── dispatch ─────────────────────────────

func handleCall(_ id: Any, _ name: String, _ args: [String: Any]) {
    if name == "list_apps" {
        var lines: [String] = []
        for a in NSWorkspace.shared.runningApplications where a.activationPolicy == .regular {
            let n = a.localizedName ?? "?"
            let el = AXUIElementCreateApplication(a.processIdentifier)
            let wins = (axAttr(el, kAXWindowsAttribute as String) as? [AXUIElement])?.count ?? 0
            let tag = isAllowed(n) ? "" : "  [NOT ALLOWED]"
            lines.append("\(n)  pid=\(a.processIdentifier)  windows=\(wins)\(tag)")
        }
        lines.append("\nNote: apps on other macOS Spaces report 0 windows and cannot be reached.")
        textResult(id, lines.joined(separator: "\n"))
        return
    }

    guard let appName = args["app"] as? String else {
        textResult(id, "missing 'app'", isError: true); return
    }
    guard isAllowed(appName) else {
        textResult(id, "'\(appName)' is not in the allowlist. Allowed: \(allowedApps.sorted().joined(separator: ", "))", isError: true)
        return
    }
    guard let (app, pid) = resolveApp(appName) else {
        textResult(id, "app '\(appName)' not running (or has no regular window)", isError: true); return
    }

    switch name {

    case "find":
        guard let win = axWindow(app) else { textResult(id, "no reachable window", isError: true); return }
        let wantLabel = (args["label"] as? String)?.lowercased()
        let wantRole = args["role"] as? String
        var hits: [String] = []
        for n in walk(win) {
            if let r = wantRole, n.role != r { continue }
            if let l = wantLabel, !n.label.lowercased().contains(l) { continue }
            if wantLabel == nil && wantRole == nil && !isInteresting(n) { continue }
            if n.label.isEmpty && n.actions.isEmpty { continue }
            let acts = n.actions.isEmpty ? "" : "  actions=\(n.actions.joined(separator: ","))"
            hits.append("id=\(n.id)  \(n.role)  \"\(n.label)\"\(acts)")
        }
        textResult(id, hits.isEmpty ? "no matches" : hits.prefix(80).joined(separator: "\n"))

    case "get_tree":
        let wi = args["window"] as? Int ?? 0
        guard let win = axWindow(app, index: wi) else { textResult(id, "no window \(wi)", isError: true); return }
        let roleFilter = (args["roles"] as? String)?
            .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        let depth = args["max_depth"] as? Int ?? 14
        let showAll = args["all"] as? Bool ?? false
        var lines: [String] = ["window: \"\(axLabel(win))\""]
        for n in walk(win, maxDepth: depth) {
            if let rf = roleFilter, !rf.contains(n.role) { continue }
            if !showAll && roleFilter == nil && !isInteresting(n) { continue }
            let pad = String(repeating: "  ", count: n.depth)
            let acts = n.actions.isEmpty ? "" : "  [\(n.actions.joined(separator: ","))]"
            lines.append("\(n.id)\t\(pad)\(n.role)  \"\(n.label)\"\(acts)")
        }
        textResult(id, lines.joined(separator: "\n"))

    case "press":
        guard let target = args["id"] as? Int, let win = axWindow(app) else {
            textResult(id, "bad args", isError: true); return
        }
        let nodes = walk(win)
        guard target < nodes.count else { textResult(id, "id out of range", isError: true); return }
        let n = nodes[target]
        let r = AXUIElementPerformAction(n.el, kAXPressAction as CFString)
        textResult(id, r == .success
            ? "pressed \(n.role) \"\(n.label)\" — app was NOT brought to front. Element ids may have changed; re-run find before the next action."
            : "AXPress failed (\(r.rawValue)) on \(n.role) \"\(n.label)\"", isError: r != .success)

    case "set_value":
        guard let target = args["id"] as? Int, let text = args["text"] as? String,
              let win = axWindow(app) else { textResult(id, "bad args", isError: true); return }
        let nodes = walk(win)
        guard target < nodes.count else { textResult(id, "id out of range", isError: true); return }
        let n = nodes[target]
        let r = AXUIElementSetAttributeValue(n.el, kAXValueAttribute as CFString, text as CFTypeRef)
        textResult(id, r == .success
            ? "set \(n.role) \"\(n.label)\" = \"\(text)\""
            : "setValue failed (\(r.rawValue)). Field may need focus, or the app may not support AXValue writes.",
            isError: r != .success)

    case "fill_form":
        guard let fields = args["fields"] as? [String: Any], let win = axWindow(app) else {
            textResult(id, "bad args", isError: true); return
        }
        let nodes = walk(win)
        var log: [String] = []
        for (k, v) in fields {
            guard let idx = Int(k), idx < nodes.count else { log.append("\(k): bad id"); continue }
            let n = nodes[idx]
            let r = AXUIElementSetAttributeValue(n.el, kAXValueAttribute as CFString, "\(v)" as CFTypeRef)
            log.append("\(k) (\(n.label)): \(r == .success ? "ok" : "failed \(r.rawValue)")")
        }
        textResult(id, log.joined(separator: "\n"))

    case "menu_action":
        guard let path = args["path"] as? String else { textResult(id, "need path", isError: true); return }
        guard var cur = axAttr(app, kAXMenuBarAttribute as String).map({ $0 as! AXUIElement }) else {
            textResult(id, "no menu bar", isError: true); return
        }
        let parts = path.split(separator: ">").map { $0.trimmingCharacters(in: .whitespaces) }
        for (i, want) in parts.enumerated() {
            let kids = axChildren(cur)
            guard let hit = kids.first(where: { axLabel($0).lowercased() == want.lowercased() }) else {
                textResult(id, "menu item '\(want)' not found. Available: \(kids.map { axLabel($0) }.filter { !$0.isEmpty }.joined(separator: ", "))", isError: true)
                return
            }
            if i == parts.count - 1 {
                let r = AXUIElementPerformAction(hit, kAXPressAction as CFString)
                textResult(id, r == .success ? "menu: \(path) — ok" : "menu press failed (\(r.rawValue))",
                           isError: r != .success)
                return
            }
            // descend into the submenu container
            cur = axChildren(hit).first ?? hit
        }

    case "capture_window":
        guard let b64 = captureWindow(pid: pid) else {
            textResult(id, "capture failed. Grant Screen Recording permission, and note the window must be on the current Space.", isError: true)
            return
        }
        imageResult(id, b64, "\(appName) window (captured in background — app not brought to front)")

    default:
        textResult(id, "unknown tool \(name)", isError: true)
    }
}

// ───────────────────────────── stdio loop ─────────────────────────────

FileHandle.standardError.write("ax-mcp ready. allowlist: \(allowedApps.isEmpty ? "(empty — nothing allowed)" : allowedApps.sorted().joined(separator: ", "))\n".data(using: .utf8)!)

while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty,
          let d = line.data(using: .utf8),
          let msg = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          let method = msg["method"] as? String else { continue }
    let id = msg["id"] ?? NSNull()

    switch method {
    case "initialize":
        emit(["jsonrpc": "2.0", "id": id, "result": [
            "protocolVersion": "2024-11-05",
            "capabilities": ["tools": [:] as [String: Any]],
            "serverInfo": ["name": "ax-mcp", "version": "0.1.0"]
        ]])

    case "notifications/initialized":
        break

    case "tools/list":
        emit(["jsonrpc": "2.0", "id": id, "result": ["tools": tools]])

    case "tools/call":
        guard AXIsProcessTrusted() else {
            textResult(id, "Accessibility permission not granted to the process running ax-mcp (your terminal or Claude Code). System Settings → Privacy & Security → Accessibility.", isError: true)
            continue
        }
        let p = msg["params"] as? [String: Any] ?? [:]
        let name = p["name"] as? String ?? ""
        let args = p["arguments"] as? [String: Any] ?? [:]
        handleCall(id, name, args)

    default:
        if !(id is NSNull) {
            emit(["jsonrpc": "2.0", "id": id,
                  "error": ["code": -32601, "message": "method not found: \(method)"]])
        }
    }
}
