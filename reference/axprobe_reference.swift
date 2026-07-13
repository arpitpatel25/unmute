// axprobe.swift v2 — direct AXUIElement, with real error reporting.
// Build:  swiftc -O axprobe.swift -o axprobe
// Usage:  ./axprobe apps
//         ./axprobe diag  <pid>
//         ./axprobe tree  <pid>
//         ./axprobe press <pid> <n>
//         ./axprobe type  <pid> <n> "text"

import Cocoa
import ApplicationServices

func errName(_ e: AXError) -> String {
    switch e {
    case .success: return "success"
    case .failure: return "failure"
    case .illegalArgument: return "illegalArgument"
    case .invalidUIElement: return "invalidUIElement"
    case .cannotComplete: return "cannotComplete (app not answering AX / timeout)"
    case .attributeUnsupported: return "attributeUnsupported"
    case .actionUnsupported: return "actionUnsupported"
    case .notImplemented: return "notImplemented (app does not implement AX)"
    case .apiDisabled: return "apiDisabled (NO ACCESSIBILITY PERMISSION)"
    case .noValue: return "noValue"
    default: return "other(\(e.rawValue))"
    }
}

func attr(_ el: AXUIElement, _ key: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, key as CFString, &v) == .success ? v : nil
}

func str(_ el: AXUIElement, _ key: String) -> String? { attr(el, key) as? String }

func children(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func actions(_ el: AXUIElement) -> [String] {
    var a: CFArray?
    guard AXUIElementCopyActionNames(el, &a) == .success else { return [] }
    return (a as? [String]) ?? []
}

func frontmost() -> String { NSWorkspace.shared.frontmostApplication?.localizedName ?? "?" }

func label(_ el: AXUIElement) -> String {
    for k in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
              "AXPlaceholderValue", "AXHelp"] as [String] {
        if let s = str(el, k), !s.isEmpty { return s }
    }
    return "-"
}

func windows(_ app: AXUIElement) -> (wins: [AXUIElement], err: AXError) {
    var v: CFTypeRef?
    let e = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &v)
    return ((v as? [AXUIElement]) ?? [], e)
}


/// Turn on the accessibility tree for an app.
/// - Electron/Chromium apps gate their tree behind AXManualAccessibility.
/// - AppKit apps sometimes want AXEnhancedUserInterface.
/// Try both; ignore failures.
func enableAX(_ app: AXUIElement) {
    let m = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    let e = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    FileHandle.standardError.write("  [enableAX] manual=\(errName(m)) enhanced=\(errName(e))\n".data(using: .utf8)!)
    usleep(400_000)
}

/// AXWindows can come back empty even when the app has a window.
/// Fall back to AXMainWindow / AXFocusedWindow.
func anyWindow(_ app: AXUIElement) -> AXUIElement? {
    let (w, _) = windows(app)
    if let f = w.first { return f }
    for k in ["AXMainWindow", "AXFocusedWindow"] {
        var v: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, k as CFString, &v) == .success, let v = v {
            return (v as! AXUIElement)
        }
    }
    return nil
}

func flatten(_ root: AXUIElement) -> [(Int, Int, AXUIElement)] {
    var out: [(Int, Int, AXUIElement)] = []
    var n = 0
    func walk(_ el: AXUIElement, _ d: Int) {
        if d > 12 || n > 1500 { return }
        out.append((n, d, el)); n += 1
        for c in children(el) { walk(c, d + 1) }
    }
    walk(root, 0)
    return out
}

func pad(_ s: String, _ w: Int) -> String {
    s.count >= w ? String(s.prefix(w)) : s + String(repeating: " ", count: w - s.count)
}

let args = CommandLine.arguments
guard args.count > 1 else {
    print("usage: axprobe apps | diag <pid> | tree <pid> | press <pid> <n> | type <pid> <n> \"text\"")
    exit(1)
}

print("AXIsProcessTrusted: \(AXIsProcessTrusted())\n")

switch args[1] {

case "apps":
    for a in NSWorkspace.shared.runningApplications where a.activationPolicy == .regular {
        let app = AXUIElementCreateApplication(a.processIdentifier)
        let (w, e) = windows(app)
        let name = a.localizedName ?? "?"
        print("\(pad(name, 22)) pid=\(pad(String(a.processIdentifier), 8)) windows=\(w.count)   \(e == .success ? "" : errName(e))")
    }

case "diag":
    guard args.count > 2, let pid = Int32(args[2]) else { print("need pid"); exit(1) }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 5.0)

    print("--- before AXEnhancedUserInterface ---")
    var (w, e) = windows(app)
    print("windows=\(w.count)  err=\(errName(e))")

    var names: CFArray?
    let ne = AXUIElementCopyAttributeNames(app, &names)
    print("attribute names err=\(errName(ne))")
    if let n = names as? [String] { print("attributes: \(n.joined(separator: ", "))") }

    print("\n--- enabling AX (manual + enhanced) ---")
    enableAX(app)

    (w, e) = windows(app)
    print("AXWindows=\(w.count)  err=\(errName(e))")
    for (i, win) in w.enumerated() { print("  [\(i)] \(label(win))  children=\(children(win).count)") }

    if let win = anyWindow(app) {
        print("anyWindow: \(label(win))  children=\(children(win).count)  subtree=\(flatten(win).count) nodes")
    } else {
        print("anyWindow: NONE")
    }

case "tree":
    guard args.count > 2, let pid = Int32(args[2]) else { print("need pid"); exit(1) }
    let before = frontmost()
    print("FRONTMOST BEFORE: \(before)\n")

    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 5.0)
    enableAX(app)

    guard let win = anyWindow(app) else {
        print("no window reachable via AXWindows / AXMainWindow / AXFocusedWindow")
        exit(1)
    }
    let (wins, _) = windows(app)
    print("windows: \(wins.count) (via AXWindows)")
    print("using: \(label(win))")
    print("\n--- TREE ---")

    var actionable = 0
    for (idx, depth, el) in flatten(win) {
        let role = str(el, kAXRoleAttribute as String) ?? "?"
        let acts = actions(el).filter { $0 != "AXShowMenu" }
        let indent = String(repeating: "  ", count: depth)
        if acts.isEmpty {
            print("\(idx)\t\(indent)\(role) | \(label(el))")
        } else {
            actionable += 1
            print("\(idx)\t\(indent)\(role) | \(label(el)) | [\(acts.joined(separator: ","))]")
        }
    }
    print("\nactionable: \(actionable)")

    let after = frontmost()
    print("\nFRONTMOST AFTER:  \(after)")
    print(before == after ? "✓ FOCUS UNCHANGED" : "✗ FOCUS STOLEN")

case "press", "type":
    guard args.count > 3, let pid = Int32(args[2]), let target = Int(args[3]) else {
        print("need pid and index"); exit(1)
    }
    let before = frontmost()
    print("FRONTMOST BEFORE: \(before)")

    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 5.0)
    enableAX(app)

    guard let win = anyWindow(app) else { print("no window"); exit(1) }
    let flat = flatten(win)
    guard target < flat.count else { print("index out of range (max \(flat.count - 1))"); exit(1) }
    let el = flat[target].2
    print("target: \(str(el, kAXRoleAttribute as String) ?? "?") | \(label(el))")

    if args[1] == "press" {
        let r = AXUIElementPerformAction(el, kAXPressAction as CFString)
        print("AXPress: \(errName(r))")
    } else {
        guard args.count > 4 else { print("need text"); exit(1) }
        let r = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, args[4] as CFTypeRef)
        print("setValue: \(errName(r))")
    }

    usleep(500_000)
    let after = frontmost()
    print("FRONTMOST AFTER:  \(after)")
    print(before == after ? "✓ FOCUS UNCHANGED — background control WORKS" : "✗ FOCUS STOLEN")

default:
    print("unknown command")
}
