import Foundation
import AppKit
import SwiftUI

func check(_ name: String, _ ok: Bool) {
    print("\(ok ? "PASS" : "FAIL")  \(name)")
    if !ok { exit(1) }
}

func near(_ a: CGFloat, _ b: CGFloat, _ tol: CGFloat = 0.5) -> Bool { abs(a - b) <= tol }

// The EXACT line scratchpadPayload() in init.ts produces, with a focused task.
let full = #"""
{"type":"scratchpad","data":{"enabled":true,"armed":true,"delivering":false,"pad":{"id":"p1","origin":"task","entries":[{"id":"s1","type":"segment","text":"add the retry to the uploader","startMs":1000,"endMs":8400},{"id":"i1","type":"insert","kind":"image","content":"/Users/x/Desktop/Screenshots/Shot 1.png","atMs":5000},{"id":"i2","type":"insert","kind":"url","content":"https://example.com/a","atMs":6000}]},"destinations":{"cursor":true,"newTask":true,"openTask":{"id":"t9","name":"uploader work"}}}}
"""#
guard case let .scratchpad(p) = Command.decode(full) else { check("full payload decodes", false); exit(1) }
check("full payload decodes", true)
check("armed", p.armed == true)
check("delivering", p.delivering == false)
check("3 entries", p.pad?.entries.count == 3)
check("segment duration label", p.pad?.entries[0].durationLabel == "0:07")
check("image preview is the file name", p.pad?.entries[1].preview == "Shot 1.png")
check("url glyph", p.pad?.entries[2].glyph == "link")
check("openTask decoded", p.destinations.openTask?.name == "uploader work")
let ord = p.destinations.ordered(origin: p.pad?.origin ?? "cursor")
check("3 destinations, task primary", ord.count == 3 && ord[0].id == "openTask" && ord[0].isPrimary)
check("cursor is an alternative", ord[2].id == "cursor" && !ord[2].isPrimary)
check("hasContent", p.hasContent)

// NO openTask, cursor origin — what a plain dictation pad looks like.
let noTask = #"{"type":"scratchpad","data":{"enabled":true,"armed":false,"delivering":true,"pad":{"id":"p2","origin":"cursor","entries":[{"id":"s1","type":"segment","text":"","startMs":10,"endMs":0}]},"destinations":{"cursor":true,"newTask":true,"openTask":null}}}"#
guard case let .scratchpad(q) = Command.decode(noTask) else { check("no-task payload decodes", false); exit(1) }
check("no-task payload decodes", true)
check("delivering true", q.delivering)
check("open segment has no duration", q.pad?.entries[0].durationLabel == nil)
check("open segment says so", q.pad?.entries[0].preview == "Still transcribing…")
let ord2 = q.destinations.ordered(origin: "cursor")
check("2 destinations without a focused task", ord2.count == 2 && ord2[0].id == "newTask" && ord2[1].id == "cursor")
check("cursor primary for a cursor pad", ord2[1].isPrimary)

// THE ONE THAT MATTERS: keys missing. CockpitData would throw keyNotFound and
// kill the update; every field here defaults instead.
guard case let .scratchpad(m) = Command.decode(#"{"type":"scratchpad","data":{}}"#) else { check("empty data decodes", false); exit(1) }
check("empty data decodes (no keyNotFound)", true)
check("enabled defaults FALSE — no control without a backend", !m.enabled)
check("armed defaults false", !m.armed)
check("delivering defaults false", !m.delivering)
check("pad defaults nil → no panel", m.pad == nil && !m.hasContent)

guard case let .scratchpad(n) = Command.decode(#"{"type":"scratchpad","data":{"pad":{"entries":[{"id":"only-an-id"}]}}}"#) else { check("partial entry decodes", false); exit(1) }
check("partial entry decodes", n.pad?.entries.count == 1)
check("entry type defaults to insert", n.pad?.entries[0].isSegment == false)

// AN ID-LESS ENTRY IS NOT DRAWN. Its × could not remove it (the controller
// drops `scratchpadRemove id:""`) and two of them would collide as ForEach
// identities — a row that cannot be removed is worse than one that is not there.
let idless = #"{"type":"scratchpad","data":{"pad":{"id":"p","entries":[{"id":"keep","type":"insert","content":"a"},{"type":"insert","content":"b"},{"id":"","type":"insert","content":"c"}]}}}"#
guard case let .scratchpad(x) = Command.decode(idless) else { check("id-less payload decodes", false); exit(1) }
check("id-less entries are filtered out", x.pad?.entries.count == 1)
check("the one with an id survives", x.pad?.entries.first?.id == "keep")

// An entirely absent `data` must not become .unknown-and-dropped either.
guard case .scratchpad = Command.decode(#"{"type":"scratchpad"}"#) else { check("missing data → empty payload", false); exit(1) }
check("missing data → empty payload", true)

// Events out.
check("arm event", (Event.scratchpadArm(true).json["type"] as? String) == "scratchpadArm"
      && (Event.scratchpadArm(true).json["on"] as? Bool) == true)
check("remove event", (Event.scratchpadRemove(id: "e1").json["id"] as? String) == "e1")
check("deliver event", (Event.scratchpadDeliver(dest: "openTask").json["dest"] as? String) == "openTask")
check("discard event", (Event.scratchpadDiscard.json["type"] as? String) == "scratchpadDiscard")

// The unarmed fast path: a `pill` line must still decode exactly as before.
guard case let .pill(ps) = Command.decode(#"{"type":"pill","state":{"phase":"recording","elapsed":3}}"#) else { check("pill still decodes", false); exit(1) }
check("pill still decodes", ps.phase == .recording && ps.elapsed == 3)

// THE PAUSED PILL. Main pushes this instead of hiding when an armed stop leaves
// work on the pad; the rawValue must match the string hideNativePill() sends, or
// the phase silently falls back to .hidden and the pill disappears exactly as it
// used to.
guard case let .pill(paused) = Command.decode(#"{"type":"pill","state":{"phase":"paused","model":"Sonnet 4.5"}}"#) else { check("paused pill decodes", false); exit(1) }
check("paused pill decodes", paused.phase == .paused)
check("paused pill keeps the chips it was pushed with", paused.model == "Sonnet 4.5")

// AN UNKNOWN PHASE MUST NOT KILL THE LINE — an older helper against a newer
// engine falls back to hidden rather than dropping the command whole.
guard case let .pill(future) = Command.decode(#"{"type":"pill","state":{"phase":"teleporting","elapsed":9}}"#) else { check("unknown phase still decodes", false); exit(1) }
check("unknown phase still decodes", future.phase == .hidden && future.elapsed == 9)

// AUTO-PRESENT. Additive command; ABSENT MEANS ON, because the setting's
// default is on and a mistyped line must never silently stop the surface
// presenting itself.
guard case let .autoPresent(a1) = Command.decode(#"{"type":"autoPresent","on":false}"#) else { check("autoPresent decodes", false); exit(1) }
check("autoPresent decodes", a1 == false)
guard case let .autoPresent(a2) = Command.decode(#"{"type":"autoPresent"}"#) else { check("autoPresent without `on` decodes", false); exit(1) }
check("absent `on` defaults to ON", a2 == true)
guard case let .autoPresent(a3) = Command.decode(#"{"type":"autoPresent","on":"maybe"}"#) else { check("malformed autoPresent decodes", false); exit(1) }
check("malformed `on` defaults to ON", a3 == true)

// ── GEOMETRY ─────────────────────────────────────────────────────────────────
//
// The layout maths, with the screen measurements handed in rather than read
// from NSScreen — the numbers below are what `current()` would have measured on
// a 14" MacBook Pro. This is the part that decides whether the surface sits in
// the menu bar row and whether the mass lands on the hole.

let screen = NSRect(x: 0, y: 0, width: 1512, height: 982)
let barH: CGFloat = 37
let cut = NSRect(x: 656, y: 982 - barH, width: 200, height: barH)
let notched = NotchGeometry(screenFrame: screen, hasNotch: true, cutout: cut,
                            barHeight: barH, leftUsable: 656, rightUsable: 656)

check("bar fillet is derived from the measured bar", notched.barFillet == round(barH * NotchGeometry.filletOfBar))
check("outer radius is derived from the measured bar", notched.barCornerRadius == round(barH * NotchGeometry.cornerOfBar))

let m1 = notched.mass(left: 120, right: 300)
check("the middle IS the cutout", m1.middle == cut.width)
check("mass width = fillet + left + cutout + right + fillet",
      m1.width == notched.barFillet * 2 + 120 + cut.width + 300)

let f1 = notched.barFrame(m1)
check("unexpanded height IS the measured menu bar", f1.height == barH)
check("top edge is the SCREEN's top edge, not below the bar", f1.maxY == screen.maxY)
check("the mass's middle lands exactly on the cutout",
      near(f1.minX + m1.fillet + m1.left, cut.minX) && near(f1.minX + m1.fillet + m1.left + m1.middle, cut.maxX))

// Overflow: the right half truncates to the room beside the cutout, and is
// DROPPED rather than ellipsised when what is left cannot say anything.
let tight = NotchGeometry(screenFrame: screen, hasNotch: true, cutout: cut,
                          barHeight: barH, leftUsable: 656, rightUsable: 60)
check("right half is dropped when there is no useful room", tight.mass(left: 120, right: 300).right == 0)
let squeeze = NotchGeometry(screenFrame: screen, hasNotch: true, cutout: cut,
                            barHeight: barH, leftUsable: 656, rightUsable: 200)
let m2 = squeeze.mass(left: 120, right: 300)
check("right half truncates to the usable area",
      m2.right == 200 - squeeze.barFillet - NotchGeometry.barEdgeKeepOut)
check("left half is NEVER truncated", squeeze.mass(left: 900, right: 0).left == 900)

// A display with no cutout: same mass, centred, no reserved middle.
let plain = NotchGeometry(screenFrame: screen, hasNotch: false, cutout: nil,
                          barHeight: 24, leftUsable: 756, rightUsable: 756)
let m3 = plain.mass(left: 120, right: 200)
check("no cutout ⇒ the halves are separated by a plain gap", m3.middle == NotchGeometry.segmentGap)
check("one half only ⇒ no gap at all", plain.mass(left: 120, right: 0).middle == 0)
let f3 = plain.barFrame(m3)
check("with no cutout the mass centres on the screen", near(f3.midX, screen.midX, 1))
check("and still sits in the menu bar row", f3.height == 24 && f3.maxY == screen.maxY)

// Dormant reserves nothing on a display with no cutout, and exactly the cutout
// (inset, so no black can spill past its rounded corners) on one with.
check("dormant reserves nothing without a cutout", plain.dormantFrame().width == 2)
let dz = notched.dormantFrame()
check("dormant hides inside the cutout", dz.width == cut.width - 2 && dz.minX == cut.minX + 1)
check("dormant is still bar height", dz.height == barH && dz.maxY == screen.maxY)

// ── THE SHAPE ────────────────────────────────────────────────────────────────
//
// ONE PATH: the fillets are geometry, not an overlay, and only the OUTER bottom
// corners carry a radius — the stretch that crosses the cutout is straight.

let rect = CGRect(x: 0, y: 0, width: 400, height: 37)
let sh = NotchShape(bottomRadius: 11, topFillet: 11).path(in: rect)
// The flare: along the top edge the black reaches OUT past the mass's wall…
check("the flare is part of the path", sh.contains(CGPoint(x: 6, y: 0.5)))
// …and the region under it is bitten away, which is what makes it concave.
check("the fillet is CONCAVE — bitten out below the flare", !sh.contains(CGPoint(x: 5, y: 5.5)))
check("a fillet-less shape has no bite at all",
      NotchShape(bottomRadius: 11, topFillet: 0).path(in: rect).contains(CGPoint(x: 5, y: 5.5)))
check("the mass's wall is where the fillet ends",
      sh.contains(CGPoint(x: 10.6, y: 5.5)) && sh.contains(CGPoint(x: 12, y: 11)))
check("both ends are treated alike",
      sh.contains(CGPoint(x: 394, y: 0.5)) && !sh.contains(CGPoint(x: 395, y: 5.5)))
check("the bottom edge is straight where it crosses the cutout",
      sh.contains(CGPoint(x: 200, y: 36.5)))
check("the OUTER bottom corners are rounded",
      !sh.contains(CGPoint(x: 11.5, y: 36.5)) && !sh.contains(CGPoint(x: 388.5, y: 36.5)))
// A mass narrower than its own corners is the last frame of a collapse; it must
// degenerate rather than fold inside out.
check("a degenerate mass still produces a path",
      !NotchShape(bottomRadius: 40, topFillet: 40).path(in: CGRect(x: 0, y: 0, width: 6, height: 6)).isEmpty)

// ── MOTION ───────────────────────────────────────────────────────────────────

check("one spring: response 0.34", Theme.springResponse == 0.34)
check("one spring: damping 0.82", Theme.springDamping == 0.82)
let sp = Theme.springSolver
check("an axis that has not started yet has not moved", sp.value(at: -0.05) == 0 && sp.value(at: 0) == 0)
check("it settles at 1", sp.value(at: sp.settle) == 1 && sp.value(at: 9) == 1)
check("it settles in well under half a second", sp.settle < 0.5)
check("it is under-damped — it overshoots and comes back",
      stride(from: 0.0, to: sp.settle, by: 0.005).contains { sp.value(at: $0) > 1.0 })
check("content leaves before the shape and arrives after it",
      Theme.contentOutDuration < Theme.contentInDuration && Theme.contentInDelay > 0)

// ── WHAT THE BAR SAYS ────────────────────────────────────────────────────────

let vm = NotchModel()
vm.working = 2
check("dormant says nothing at all", BarContent.make(for: vm, state: .dormant, hovering: false).isEmpty)
let idle = BarContent.make(for: vm, state: .idle, hovering: false)
check("idle is ONE segment — the wordmark", idle.left == "unmute" && idle.right == nil && idle.dot == nil)
check("hover REVEALS the count", BarContent.make(for: vm, state: .idle, hovering: true).right == "2 running")
check("idle never glows", idle.alarm == nil)
let act = BarContent.make(for: vm, state: .active, hovering: false)
check("active carries the count on the left", act.left == "2 running" && act.dot == .processing)
check("active never glows", act.alarm == nil)
let att = BarContent.make(for: vm, state: .attention, hovering: false)
check("attention says what it needs", att.left == "Needs you" && att.dot == .needsUser)
check("attention is the ONLY state that glows", att.alarm != nil)

print("\nALL DECODE CHECKS PASSED")
