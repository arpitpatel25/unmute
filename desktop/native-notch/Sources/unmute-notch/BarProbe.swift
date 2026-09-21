import AppKit
import SwiftUI

// WHERE DOES THE BLACK ACTUALLY END? Answered by rendering, not by eye.
//
// The same regression — the mass hanging a few points below the menu bar in a
// windowed app — came back twice, and both times the only instrument was the
// user's screenshot. This renders the real NotchView through the same hosting
// mechanism the window uses, into a window-sized rect, and reads the pixels
// back. It needs no Screen Recording permission: it is our own view.
//
// Run: UNMUTE_NOTCH_PROBE=1 .build/release/unmute-notch
// Prints, for each case, the rows the mass is opaque black in, measured down
// the middle of the housing where there is no content and no corner — and
// EXITS NON-ZERO if the mass is anywhere but flush with the top and exactly
// menu-bar height. Checks/run.sh runs it, so the regression it caught cannot
// come back a third time silently.
enum BarProbe {
    static func runIfRequested() {
        guard ProcessInfo.processInfo.environment["UNMUTE_NOTCH_PROBE"] != nil else { return }
        let g = NotchGeometry.current()
        // The window is always given the rim's extra room here, hovered or not:
        // that is the frame the surface sits in while the window is animating
        // between the two, which is the case a live screenshot cannot pin down.
        var failed = false
        for hovering in [false, true] {
            let m = NotchModel()
            m.hasNotch = true
            m.working = 3
            m.state = .active
            m.hovering = hovering
            let c = BarContent.make(for: m, state: .active, hovering: hovering)
            let sh = c.shoulders
            let place = g.mass(left: sh.left, right: sh.right, rimDrop: NotchGeometry.rimDrop)
            m.content = c
            m.bar = place

            let size = NSSize(width: place.width, height: place.totalHeight)
            let host = NSHostingView(rootView: NotchView(model: m, topInset: 0))
            host.frame = NSRect(origin: .zero, size: size)
            host.layoutSubtreeIfNeeded()
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { continue }
            host.cacheDisplay(in: host.bounds, to: rep)

            let scale = CGFloat(rep.pixelsHigh) / size.height
            let x = Int((place.fillet + place.left + place.middle / 2) * scale)
            var firstBlack: Int? = nil, lastBlack: Int? = nil, lightRows: [Int] = []
            for y in 0..<rep.pixelsHigh {
                guard let px = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                let lum = (px.redComponent + px.greenComponent + px.blueComponent) / 3
                if px.alphaComponent > 0.9 && lum < 0.08 {
                    if firstBlack == nil { firstBlack = y }
                    lastBlack = y
                } else if px.alphaComponent > 0.1 && lum > 0.2 {
                    lightRows.append(y)
                }
            }
            let pt = { (p: Int?) in p.map { String(format: "%.1f", CGFloat($0) / scale) } ?? "—" }
            print("hovering=\(hovering) window=\(Int(size.width))x\(Int(size.height))pt "
                  + "mass.height=\(Int(place.height)) black rows=\(pt(firstBlack))..\(pt(lastBlack.map { $0 + 1 }))pt "
                  + "light rows=\(lightRows.map { String(format: "%.1f", CGFloat($0) / scale) })")

            // FLUSH WITH THE TOP, AND NOT A POINT TALLER THAN THE MENU BAR.
            // Half a point of slack for the pixel grid at 1x.
            let top = firstBlack.map { CGFloat($0) / scale } ?? .infinity
            let bottom = lastBlack.map { CGFloat($0 + 1) / scale } ?? .infinity
            if top > 0.5 || abs(bottom - place.height) > 0.5 {
                print("FAIL  the mass must be flush with the top and exactly \(Int(place.height))pt tall")
                failed = true
            }

            if let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: "/tmp/notch-probe-\(hovering ? "hover" : "rest").png"))
            }
        }
        print(failed ? "BAR PROBE FAILED" : "BAR PROBE PASSED")
        exit(failed ? 1 : 0)
    }
}
